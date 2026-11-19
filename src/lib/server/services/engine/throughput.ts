/**
 * Download rates for the dashboard: bytes and messages stored, summed per second and kept for
 * 15 minutes, so the console can show the last minute and the last 15 minutes. Graph throttling
 * (429 and 503 replies the client waited out) is counted the same way.
 */
const WINDOW_MS = 15 * 60_000;
const BUCKET_MS = 1_000;

type Bucket = { at: number; bytes: number; messages: number; throttled: number };

export type Rates = {
	/** Bytes per second over the window. */
	bytesPerSecond: number;
	messagesPerSecond: number;
	throttled: number;
};

export class Throughput {
	readonly #buckets: Bucket[] = [];

	record(now: number, change: { bytes?: number; messages?: number; throttled?: number }): void {
		const at = Math.floor(now / BUCKET_MS) * BUCKET_MS;
		let bucket = this.#buckets.at(-1);
		if (bucket?.at !== at) {
			bucket = { at, bytes: 0, messages: 0, throttled: 0 };
			this.#buckets.push(bucket);
		}
		bucket.bytes += change.bytes ?? 0;
		bucket.messages += change.messages ?? 0;
		bucket.throttled += change.throttled ?? 0;
		this.#prune(now);
	}

	/** Rates over the last `windowMs` (up to 15 minutes). */
	rates(now: number, windowMs: number): Rates {
		this.#prune(now);
		const since = now - windowMs;
		let bytes = 0;
		let messages = 0;
		let throttled = 0;
		for (const bucket of this.#buckets) {
			if (bucket.at >= since) {
				bytes += bucket.bytes;
				messages += bucket.messages;
				throttled += bucket.throttled;
			}
		}
		const seconds = windowMs / 1000;
		return { bytesPerSecond: bytes / seconds, messagesPerSecond: messages / seconds, throttled };
	}

	#prune(now: number): void {
		while (this.#buckets.length > 0 && (this.#buckets[0]?.at ?? now) < now - WINDOW_MS) {
			this.#buckets.shift();
		}
	}
}

/**
 * How many mailboxes sync at once (docs/specs/SPEC-THROUGHPUT.md 4.3). The governor paces every
 * request, so more mailboxes cannot overload Microsoft; they only help while the governor has
 * room for more work. So a mailbox slot is added every few seconds while mailboxes are waiting,
 * every slot is busy and the governor has headroom, up to the setting's maximum. When it has no
 * headroom (Microsoft asked it to slow down, or requests wait for its pace), the slots shrink to
 * those in use, so no new mailbox starts until there is room again.
 */
export class MailboxSlots {
	static readonly START = 3;
	static readonly GROW_EVERY_MS = 10_000;
	#slots = MailboxSlots.START;
	#lastGrowth: number;

	constructor(now: number) {
		this.#lastGrowth = now;
	}

	/** The slots to use now. */
	adjust(state: {
		maximum: number;
		headroom: boolean;
		running: number;
		waiting: number;
		now: number;
	}): number {
		const { maximum, headroom, running, waiting, now } = state;
		if (!headroom) {
			this.#slots = Math.max(1, Math.min(this.#slots, running));
		} else if (
			waiting > 0 &&
			running >= this.#slots &&
			now - this.#lastGrowth >= MailboxSlots.GROW_EVERY_MS
		) {
			this.#slots += 1;
			this.#lastGrowth = now;
		}
		this.#slots = Math.max(1, Math.min(this.#slots, maximum));
		return this.#slots;
	}
}
