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
 * How many mailboxes sync at once, adjusted like TCP's congestion control: one more every few
 * minutes while Graph does not throttle, half as many when it does, never above the setting's
 * maximum or below one. Graph limits each mailbox to about 4 requests at a time, so parallel
 * mailboxes are where the speed comes from, and throttling is the signal to back off.
 */
export class AdaptiveSlots {
	#slots: number;
	#lastChange: number;
	static readonly GROW_EVERY_MS = 2 * 60_000;
	/** Throttled replies in the last minute that mean "too many". */
	static readonly BACK_OFF_AT = 5;

	constructor(start: number, now: number) {
		this.#slots = Math.max(1, start);
		this.#lastChange = now;
	}

	/** The slots to use now, given the setting's maximum and throttling in the last minute. */
	adjust(maximum: number, throttledLastMinute: number, busy: boolean, now: number): number {
		if (this.#slots > maximum) {
			this.#slots = maximum;
			this.#lastChange = now;
		}
		if (throttledLastMinute >= AdaptiveSlots.BACK_OFF_AT) {
			if (now - this.#lastChange >= 60_000 && this.#slots > 1) {
				this.#slots = Math.max(1, Math.floor(this.#slots / 2));
				this.#lastChange = now;
			}
		} else if (
			busy &&
			throttledLastMinute === 0 &&
			this.#slots < maximum &&
			now - this.#lastChange >= AdaptiveSlots.GROW_EVERY_MS
		) {
			this.#slots += 1;
			this.#lastChange = now;
		}
		return this.#slots;
	}
}
