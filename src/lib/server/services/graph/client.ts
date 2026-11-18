import type { FetchLike, TokenSource } from './token.ts';

/**
 * Microsoft Graph over fetch, with the two things every Graph caller needs: paging through
 * `@odata.nextLink`, and backing off when Graph throttles (429) or is briefly unavailable
 * (503, 504), honouring Retry-After. Mailbox ids are always immutable ids, so a message keeps
 * its id when it moves between folders.
 */
export const GRAPH_ROOT = 'https://graph.microsoft.com';

const MAX_ATTEMPTS = 6;
const EMPTY_REPLY_ATTEMPTS = 3;
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
		for (let attempt = 1; ; attempt++) {
			const response = await this.request(path, { accept: 'application/json' });
			const text = await response.text();
			if (text.trim() !== '') {
				return JSON.parse(text);
			}
			// Graph sometimes answers 200 with no body under load. Asking again gets a real
			// reply; failing the whole mailbox sync over it would not.
			if (attempt >= EMPTY_REPLY_ATTEMPTS) {
				throw new GraphError(
					response.status,
					'empty-reply',
					`Microsoft Graph sent an empty reply ${attempt} times in a row`
				);
			}
			await this.#sleep(backoffMs(attempt, null));
		}
	}

	/** A GET of raw bytes, e.g. a message's MIME (`/messages/{id}/$value`). */
	async getBytes(path: string): Promise<Buffer> {
		const response = await this.request(path, { accept: '*/*' });
		return Buffer.from(await response.arrayBuffer());
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

	async request(path: string, headers: Record<string, string>): Promise<Response> {
		const url = path.startsWith('https://') ? path : `${GRAPH_ROOT}${path}`;
		if (!url.startsWith(`${GRAPH_ROOT}/`)) {
			throw new Error(`Refusing to send the Graph token to ${new URL(url).host}`);
		}
		for (let attempt = 1; ; attempt++) {
			const token = await this.#tokens.accessToken();
			let response: Response;
			try {
				response = await this.#fetch(url, {
					headers: {
						...headers,
						authorization: `Bearer ${token}`,
						prefer: 'IdType="ImmutableId", odata.maxpagesize=100'
					}
				});
			} catch (error) {
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
