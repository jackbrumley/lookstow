import type { FetchLike, TokenSource } from './token.ts';

/**
 * Microsoft Graph over fetch, with the two things every Graph caller needs: paging through
 * `@odata.nextLink`, and backing off when Graph throttles (429) or is briefly unavailable
 * (503, 504), honouring Retry-After. Mailbox ids are always immutable ids, so a message keeps
 * its id when it moves between folders.
 */
const GRAPH_ROOT = 'https://graph.microsoft.com';

const MAX_ATTEMPTS = 6;
/** How many times a reply that arrives empty, cut off or garbled is asked for again. */
const REPLY_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Graph asks for no more than 4 concurrent requests per mailbox; callers keep to that. */
export const PER_MAILBOX_CONCURRENCY = 4;

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
		error instanceof TypeError ||
		error instanceof SyntaxError ||
		(error instanceof GraphError && error.code === 'empty-reply')
	);
}

export type Sleep = (ms: number) => Promise<void>;

/** Told about every throttled or busy reply the client waits out (status, wait in ms). */
export type ThrottleListener = (status: number, waitMs: number) => void;

const realSleep: Sleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

export class GraphClient {
	readonly #tokens: TokenSource;
	readonly #fetch: FetchLike;
	readonly #sleep: Sleep;
	readonly #onThrottle: ThrottleListener;

	constructor(
		tokens: TokenSource,
		fetchImpl: FetchLike = fetch,
		sleep: Sleep = realSleep,
		onThrottle: ThrottleListener = () => undefined
	) {
		this.#tokens = tokens;
		this.#fetch = fetchImpl;
		this.#sleep = sleep;
		this.#onThrottle = onThrottle;
	}

	/** A GET that must answer JSON. `path` is relative to the Graph root or a full nextLink. */
	async getJson(path: string): Promise<unknown> {
		return this.#read(path, { accept: 'application/json' }, { method: 'GET' }, readJson);
	}

	/** A GET of raw bytes, e.g. a message's MIME (`/messages/{id}/$value`). */
	async getBytes(path: string): Promise<Buffer> {
		return this.#read(path, { accept: '*/*' }, { method: 'GET' }, async (response) =>
			Buffer.from(await response.arrayBuffer())
		);
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
		for (let attempt = 1; ; attempt++) {
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
					}
				});
			} catch (error) {
				if (!(error instanceof TypeError)) {
					throw error;
				}
				if (attempt >= MAX_ATTEMPTS) {
					throw new GraphError(0, 'network', `Could not reach Microsoft Graph`, {
						cause: error
					});
				}
				await this.#sleep(backoffMs(attempt, null));
				continue;
			}
			if (response.ok) {
				return response;
			}
			if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
				// Drain the body so the connection can be reused.
				await response.arrayBuffer().catch(() => undefined);
				const waitMs = backoffMs(attempt, response.headers.get('retry-after'));
				this.#onThrottle(response.status, waitMs);
				await this.#sleep(waitMs);
				continue;
			}
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
