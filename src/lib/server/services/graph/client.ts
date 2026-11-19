import { laneOf, type Governor, type Permit, type ThrottleScope } from './governor.ts';
import type { FetchLike, TokenSource } from './token.ts';

/**
 * Microsoft Graph over fetch: paging through `@odata.nextLink`, every request paced by the
 * throughput governor (governor.ts), throttling (429, 503) reported to it so the whole mailbox or
 * app waits out Microsoft's Retry-After together, time limits on every request and a watchdog on
 * every download, and one fresh sign-in after a 401. Mailbox ids are always immutable ids, so a
 * message keeps its id when it moves between folders.
 */
const GRAPH_ROOT = 'https://graph.microsoft.com';

const MAX_ATTEMPTS = 6;
/** How many times a reply that arrives empty, cut off or garbled is asked for again. */
const REPLY_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Statuses that mean "slow down": the governor makes the scope wait. */
const THROTTLE_STATUSES = new Set([429, 503]);
/** Until the reply's headers arrive (SomeDrive: a total limit for small requests). */
const HEADERS_TIMEOUT_MS = 30_000;
/** A download with no data for this long has stalled (SomeDrive's read timeout). */
const BODY_IDLE_MS = 60_000;
/**
 * Whose limit a throttled reply is about. Outlook's limits are per app per mailbox, and Microsoft
 * reports them as `ApplicationThrottled` with the limit only in the message ("Application is
 * over its MailboxConcurrency limit"), so a refusal of a request about one mailbox slows only
 * that mailbox. Reading only the code made every such refusal cut the whole app's pace, and the
 * cut was kept across restarts. Requests about no mailbox (discovery, sign-in) are app-wide.
 */
export function throttleScope(lane: string, code: string, body: string): ThrottleScope {
	if (lane !== '') return 'mailbox';
	return /MailboxConcurrency|ErrorTooManyObjectsOpened/i.test(`${code} ${body}`)
		? 'mailbox'
		: 'app';
}
export class GraphError extends Error {
	override name = 'GraphError';
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.status = status;
		this.code = code;
	}
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (text.trim() === '') {
		throw new GraphError(response.status, 'empty-reply', 'Microsoft Graph sent an empty reply');
	}
	return parseGraphJson(text);
}

/**
 * JSON.parse, accepting one fault Graph is known to make: a raw control character (U+0000 to
 * U+001F) inside a string, which strict JSON forbids. The mailbox export API sends them in its
 * replies, and asking again returns the same reply, so refusing it would stop the archive for
 * good. Those characters are escaped inside strings only, so every value keeps its exact text;
 * anything else wrong with the reply still fails.
 */
export function parseGraphJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		const repaired = escapeControlCharactersInStrings(text);
		if (repaired === text) throw error;
		return JSON.parse(repaired);
	}
}

function escapeControlCharactersInStrings(text: string): string {
	const parts: string[] = [];
	let inString = false;
	let escaped = false;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (!inString) {
			if (code === 0x22) inString = true;
			continue;
		}
		if (escaped) {
			escaped = false;
		} else if (code === 0x5c) {
			escaped = true;
		} else if (code === 0x22) {
			inString = false;
		} else if (code < 0x20) {
			parts.push(text.slice(start, index), `\\u${code.toString(16).padStart(4, '0')}`);
			start = index + 1;
		}
	}
	if (start === 0) return text;
	parts.push(text.slice(start));
	return parts.join('');
}

/**
 * A reply that broke on the way: empty, cut off or garbled while reading the body (fetch
 * throws TypeError), or JSON that ends early (SyntaxError).
 */
function isBrokenReply(error: unknown): error is Error {
	return (
		isNetworkError(error) ||
		error instanceof SyntaxError ||
		(error instanceof GraphError && error.code === 'empty-reply')
	);
}

/** A connection that failed, timed out or stalled (fetch's TypeError, or an abort Lookstow made). */
function isNetworkError(error: unknown): error is Error {
	return (
		error instanceof TypeError ||
		(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
	);
}

function timeoutError(message: string): Error {
	const error = new Error(message);
	error.name = 'TimeoutError';
	return error;
}

export type Sleep = (ms: number) => Promise<void>;

/** Told about every throttled or busy reply the client waits out (status, wait in ms). */
export type ThrottleListener = (status: number, waitMs: number) => void;

const realSleep: Sleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

export type GraphClientOptions = {
	/** Paces every request: the process's shared governor in the service. */
	governor: Governor;
	fetch?: FetchLike;
	sleep?: Sleep;
	onThrottle?: ThrottleListener;
	/** Time limits; tests shorten them. */
	timeouts?: { headersMs: number; bodyIdleMs: number };
};

export class GraphClient {
	readonly #tokens: TokenSource;
	readonly #governor: Governor;
	readonly #fetch: FetchLike;
	readonly #sleep: Sleep;
	readonly #onThrottle: ThrottleListener;
	readonly #timeouts: { headersMs: number; bodyIdleMs: number };

	constructor(tokens: TokenSource, options: GraphClientOptions) {
		this.#tokens = tokens;
		this.#governor = options.governor;
		this.#fetch = options.fetch ?? fetch;
		this.#sleep = options.sleep ?? realSleep;
		this.#onThrottle = options.onThrottle ?? (() => undefined);
		this.#timeouts = options.timeouts ?? {
			headersMs: HEADERS_TIMEOUT_MS,
			bodyIdleMs: BODY_IDLE_MS
		};
	}

	/** A GET that must answer JSON. `path` is relative to the Graph root or a full nextLink. */
	async getJson(path: string): Promise<unknown> {
		return this.#read(path, { accept: 'application/json' }, { method: 'GET' }, readJson);
	}

	/**
	 * A GET whose body goes straight to `consume` as it arrives (a message's MIME onto disk), so
	 * no reply has to fit in memory. If the body breaks on the way, the whole download is asked
	 * for again and `consume` starts afresh.
	 */
	async getStream<T>(
		path: string,
		consume: (body: ReadableStream<Uint8Array>) => Promise<T>
	): Promise<T> {
		return this.#read(path, { accept: '*/*' }, { method: 'GET' }, async (response) => {
			if (response.body === null) {
				throw new GraphError(response.status, 'empty-reply', 'Microsoft Graph sent an empty reply');
			}
			return consume(response.body);
		});
	}

	/**
	 * Sends a request and reads its reply, asking again when the reply breaks on the way: Graph
	 * sometimes answers 200 with no body under load, and a long download can be cut off or
	 * arrive garbled ("terminated", a bad compressed stream, JSON that ends early). Asking again
	 * gets a whole reply; failing the mailbox sync over one would not.
	 */
	async #read<T>(
		path: string,
		headers: Record<string, string>,
		init: { method: 'GET' | 'POST'; body?: string },
		read: (response: Response) => Promise<T>
	): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			const response = await this.request(path, headers, init);
			try {
				return await read(response);
			} catch (error) {
				if (!isBrokenReply(error)) {
					throw error;
				}
				if (attempt >= REPLY_ATTEMPTS) {
					const empty = error instanceof GraphError;
					throw new GraphError(
						response.status,
						empty ? 'empty-reply' : 'broken-reply',
						empty
							? `Microsoft Graph sent an empty reply ${attempt} times in a row`
							: `Microsoft Graph's reply broke off ${attempt} times in a row (${error.message})`,
						{ cause: error }
					);
				}
				await this.#sleep(backoffMs(attempt, null));
			}
		}
	}

	/** Every item of a collection, page by page. */
	async *pages(path: string): AsyncGenerator<{ items: unknown[]; reply: Record<string, unknown> }> {
		let next: string | undefined = path;
		while (next !== undefined) {
			const reply = asRecord(await this.getJson(next));
			const items = Array.isArray(reply['value']) ? reply['value'] : [];
			yield { items, reply };
			const link = reply['@odata.nextLink'];
			next = typeof link === 'string' ? link : undefined;
		}
	}

	/**
	 * A POST with a JSON body that answers JSON (the mailbox export API). Safe to retry: an
	 * export changes nothing in the mailbox.
	 */
	async postJson(path: string, body: unknown): Promise<unknown> {
		return this.#read(
			path,
			{ accept: 'application/json', 'content-type': 'application/json' },
			{ method: 'POST', body: JSON.stringify(body) },
			readJson
		);
	}

	async request(
		path: string,
		headers: Record<string, string>,
		init: { method: 'GET' | 'POST'; body?: string } = { method: 'GET' }
	): Promise<Response> {
		const url = path.startsWith('https://') ? path : `${GRAPH_ROOT}${path}`;
		if (!url.startsWith(`${GRAPH_ROOT}/`)) {
			throw new Error(`Refusing to send the Graph token to ${new URL(url).host}`);
		}
		const lane = laneOf(url);
		let signedInAgain = false;
		for (let attempt = 1; ; attempt++) {
			const permit = await this.#governor.acquire(lane);
			const controller = new AbortController();
			const headersTimer = setTimeout(() => {
				controller.abort(
					timeoutError(
						`No reply from Microsoft Graph within ${String(this.#timeouts.headersMs / 1000)} s`
					)
				);
			}, this.#timeouts.headersMs);
			let response: Response;
			try {
				// Signing in reaches login.microsoftonline.com, which can time out like Graph can;
				// a refusal (TokenError) is not a network error and is not asked again.
				const token = await this.#tokens.accessToken();
				// Graph answers 308 for folders and items in an auxiliary archive; fetch follows it
				// (same host, so the token goes with it, and the body is sent again).
				response = await this.#fetch(url, {
					method: init.method,
					...(init.body === undefined ? {} : { body: init.body }),
					headers: {
						...headers,
						authorization: `Bearer ${token}`,
						prefer: 'IdType="ImmutableId", odata.maxpagesize=100'
					},
					signal: controller.signal
				});
			} catch (error) {
				clearTimeout(headersTimer);
				permit.release({ kind: 'failed' });
				if (!isNetworkError(error)) {
					throw error;
				}
				if (attempt >= MAX_ATTEMPTS) {
					throw new GraphError(0, 'network', 'Could not reach Microsoft Graph', { cause: error });
				}
				await this.#sleep(backoffMs(attempt, null));
				continue;
			}
			clearTimeout(headersTimer);
			if (response.ok) {
				return watched(response, permit, controller, this.#timeouts.bodyIdleMs);
			}
			if (response.status === 401 && !signedInAgain) {
				// A token withdrawn early: sign in again once, then ask again.
				await response.arrayBuffer().catch(() => undefined);
				permit.release({ kind: 'failed' });
				this.#tokens.forget();
				signedInAgain = true;
				continue;
			}
			if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
				// Read the body for Microsoft's code and wait; it also frees the connection.
				const text = await response.text().catch(() => '');
				const code = errorCode(text) ?? `http-${String(response.status)}`;
				const waitMs = retryAfterMs(response.headers.get('retry-after'), text, attempt, Date.now());
				this.#onThrottle(response.status, waitMs);
				if (THROTTLE_STATUSES.has(response.status)) {
					// The governor makes the whole scope wait out Retry-After, then sends one probe.
					const scope = throttleScope(lane, code, text);
					permit.release({ kind: 'throttled', scope, retryAfterMs: waitMs, code });
					continue;
				}
				permit.release({ kind: 'failed' });
				await this.#sleep(waitMs);
				continue;
			}
			permit.release({ kind: 'failed' });
			throw await graphError(response);
		}
	}
}

/** Retry-After when Graph gives one (seconds), else exponential from 2 s, capped at 2 min. */
export function backoffMs(attempt: number, retryAfter: string | null): number {
	if (retryAfter !== null) {
		const seconds = Number.parseInt(retryAfter, 10);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.min(seconds, 300) * 1000;
		}
	}
	return Math.min(2000 * 2 ** (attempt - 1), 120_000);
}

/**
 * Microsoft's wait, in every form it sends: Retry-After in seconds or as an HTTP date, or
 * `retryAfterSeconds` in the JSON body; exponential back-off when it sends none.
 */
export function retryAfterMs(
	header: string | null,
	body: string,
	attempt: number,
	now: number
): number {
	const value = header?.trim() ?? '';
	if (value !== '') {
		if (/^\d+$/.test(value)) return backoffMs(attempt, value);
		const date = Date.parse(value);
		if (!Number.isNaN(date)) return Math.min(Math.max(0, date - now), 600_000);
	}
	const match = /"retryAfterSeconds"\s*:\s*(\d+)/.exec(body);
	if (match?.[1] !== undefined) return backoffMs(attempt, match[1]);
	return backoffMs(attempt, null);
}

function errorCode(body: string): string | null {
	try {
		const error = asRecord(asRecord(parseGraphJson(body))['error']);
		return typeof error['code'] === 'string' ? error['code'] : null;
	} catch {
		return null;
	}
}

/** Microsoft's early warning that most of a limit is used, where a service sends one. */
function underPressure(headers: Headers): boolean {
	const percentage = Number.parseFloat(headers.get('x-ms-throttle-limit-percentage') ?? '');
	if (Number.isFinite(percentage) && percentage >= 0.8) return true;
	const limit = Number.parseFloat(headers.get('ratelimit-limit') ?? '');
	const remaining = Number.parseFloat(headers.get('ratelimit-remaining') ?? '');
	return (
		Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0 && remaining / limit <= 0.2
	);
}

/**
 * The reply with its body watched: the permit is released (with the bytes read) when the body
 * ends, fails or is dropped, and a download that sends nothing for BODY_IDLE_MS is aborted, so a
 * stalled connection never holds a mailbox's lane for good.
 */
function watched(
	response: Response,
	permit: Permit,
	controller: AbortController,
	idleMs: number
): Response {
	const pressure = underPressure(response.headers);
	const body = response.body;
	if (body === null) {
		permit.release({ kind: 'ok', bytes: 0, pressure });
		return response;
	}
	const reader = body.getReader();
	let bytes = 0;
	let idle: ReturnType<typeof setTimeout> | null = null;
	const disarm = (): void => {
		if (idle !== null) clearTimeout(idle);
		idle = null;
	};
	const arm = (): void => {
		disarm();
		idle = setTimeout(() => {
			controller.abort(
				timeoutError(`The download stalled: no data for ${String(idleMs / 1000)} s`)
			);
		}, idleMs);
	};
	arm();
	const stream = new ReadableStream<Uint8Array>({
		async pull(output) {
			try {
				const chunk = await reader.read();
				if (chunk.done) {
					disarm();
					permit.release({ kind: 'ok', bytes, pressure });
					output.close();
					return;
				}
				bytes += chunk.value.byteLength;
				arm();
				output.enqueue(chunk.value);
			} catch (error) {
				disarm();
				permit.release({ kind: 'failed' });
				output.error(error);
			}
		},
		async cancel(reason) {
			disarm();
			permit.release({ kind: 'failed' });
			await reader.cancel(reason);
		}
	});
	return new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}

async function graphError(response: Response): Promise<GraphError> {
	const reply: unknown = await response.json().catch(() => null);
	const error = asRecord(asRecord(reply)['error']);
	const code = typeof error['code'] === 'string' ? error['code'] : `http-${response.status}`;
	const message =
		typeof error['message'] === 'string' && error['message'] !== ''
			? error['message']
			: `Microsoft Graph answered ${response.status}`;
	return new GraphError(response.status, code, message);
}

export function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return Object.fromEntries(Object.entries(value));
	}
	return {};
}

export function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === 'string' ? value : null;
}
