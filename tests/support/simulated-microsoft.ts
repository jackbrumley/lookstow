import type { RequestOutcome, Schedule } from '#lib/server/services/graph/governor.ts';

/**
 * A simulated Microsoft 365 for the throughput governor (docs/specs/SPEC-THROUGHPUT.md 6), on a
 * virtual clock so an hour of copying runs in seconds and every run is the same:
 *
 * - each mailbox allows `perMailbox` requests at once (Microsoft's 4), and answers
 *   MailboxConcurrency 429 beyond that;
 * - the app may start `appLimitPerSecond` requests in any one second, and answers
 *   ApplicationThrottled 429 with a Retry-After beyond that;
 * - optionally, replies carry Microsoft's early warning once `warnAt` of the app limit is used.
 */

/** Virtual time: timers run in order, as fast as the work between them allows. */
export class VirtualClock {
	now = 0;
	readonly #timers: { at: number; seq: number; run: () => void; cancelled: boolean }[] = [];
	#seq = 0;

	readonly schedule: Schedule = (ms, run) => {
		const timer = { at: this.now + Math.max(0, ms), seq: this.#seq++, run, cancelled: false };
		this.#timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};

	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.schedule(ms, resolve);
		});
	}

	/** Runs every timer due up to `end`, letting the promises each one wakes settle first. */
	async runUntil(end: number): Promise<void> {
		for (;;) {
			await settle();
			let next = -1;
			for (let index = 0; index < this.#timers.length; index++) {
				const timer = this.#timers[index];
				const best = next === -1 ? undefined : this.#timers[next];
				if (timer === undefined || timer.cancelled) continue;
				if (
					best === undefined ||
					timer.at < best.at ||
					(timer.at === best.at && timer.seq < best.seq)
				) {
					next = index;
				}
			}
			const timer = next === -1 ? undefined : this.#timers[next];
			if (timer === undefined || timer.at > end) {
				this.now = Math.max(this.now, end);
				return;
			}
			this.#timers.splice(next, 1);
			this.now = Math.max(this.now, timer.at);
			timer.run();
			if (this.#timers.length > 256) this.#prune();
		}
	}

	#prune(): void {
		const live = this.#timers.filter((timer) => !timer.cancelled);
		this.#timers.length = 0;
		this.#timers.push(...live);
	}
}

function settle(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

export type SimulatedLimits = {
	appLimitPerSecond: number;
	perMailbox: number;
	/** How long an accepted request takes. */
	latencyMs: number;
	/** The Retry-After of an app throttle. */
	appRetryAfterMs: number;
	/** Early warning from this share of the app limit (0.8 = 80%), or null for none. */
	warnAt: number | null;
	/** A different per-mailbox limit for some mailboxes. */
	perMailboxFor?: Record<string, number>;
};

export const MICROSOFT: SimulatedLimits = {
	appLimitPerSecond: 100,
	perMailbox: 4,
	latencyMs: 150,
	appRetryAfterMs: 5_000,
	warnAt: null
};

export class SimulatedMicrosoft {
	readonly #clock: VirtualClock;
	readonly #limits: SimulatedLimits;
	/** Start times of accepted requests in the last second (oldest first, from `#head`). */
	readonly #starts: number[] = [];
	#head = 0;
	readonly #inFlight = new Map<string, number>();
	readonly peakInFlight = new Map<string, number>();
	readonly done = new Map<string, number>();
	/** Accepted requests by the minute they finished in. */
	readonly perMinute: number[] = [];
	throttledApp = 0;
	/** When each app throttle was answered. */
	readonly appThrottledAt: number[] = [];
	throttledMailbox = 0;

	constructor(clock: VirtualClock, limits: SimulatedLimits) {
		this.#clock = clock;
		this.#limits = limits;
	}

	/** One request to `mailbox`: Microsoft's answer, after its latency. */
	async call(mailbox: string): Promise<RequestOutcome> {
		const now = this.#clock.now;
		while (this.#head < this.#starts.length && (this.#starts[this.#head] ?? now) <= now - 1000) {
			this.#head += 1;
		}
		if (this.#head > 4096) {
			this.#starts.splice(0, this.#head);
			this.#head = 0;
		}
		const inFlight = this.#inFlight.get(mailbox) ?? 0;
		const lastSecond = this.#starts.length - this.#head;
		if (inFlight >= (this.#limits.perMailboxFor?.[mailbox] ?? this.#limits.perMailbox)) {
			this.throttledMailbox += 1;
			await this.#clock.sleep(20);
			return {
				kind: 'throttled',
				scope: 'mailbox',
				retryAfterMs: 1_000,
				code: 'MailboxConcurrency'
			};
		}
		if (lastSecond >= this.#limits.appLimitPerSecond) {
			this.throttledApp += 1;
			this.appThrottledAt.push(now);
			await this.#clock.sleep(20);
			return {
				kind: 'throttled',
				scope: 'app',
				retryAfterMs: this.#limits.appRetryAfterMs,
				code: 'ApplicationThrottled'
			};
		}
		this.#starts.push(now);
		this.#inFlight.set(mailbox, inFlight + 1);
		this.peakInFlight.set(mailbox, Math.max(this.peakInFlight.get(mailbox) ?? 0, inFlight + 1));
		const pressure =
			this.#limits.warnAt !== null &&
			lastSecond + 1 >= this.#limits.warnAt * this.#limits.appLimitPerSecond;
		await this.#clock.sleep(this.#limits.latencyMs);
		this.#inFlight.set(mailbox, (this.#inFlight.get(mailbox) ?? 1) - 1);
		this.done.set(mailbox, (this.done.get(mailbox) ?? 0) + 1);
		const minute = Math.floor(this.#clock.now / 60_000);
		this.perMinute[minute] = (this.perMinute[minute] ?? 0) + 1;
		return { kind: 'ok', bytes: 50_000, pressure };
	}

	/** Accepted requests a second over the minutes [from, to). */
	ratePerSecond(fromMinute: number, toMinute: number): number {
		let total = 0;
		for (let minute = fromMinute; minute < toMinute; minute++) total += this.perMinute[minute] ?? 0;
		return total / ((toMinute - fromMinute) * 60);
	}
}

/**
 * Keeps `workers` requests asking for `mailbox` until `stop()` says so, as the engine's folder
 * and download pipelines do: each asks the governor for a permit, then calls Microsoft.
 */
export async function keepBusy(
	governor: { acquire: (lane: string) => Promise<{ release: (outcome: RequestOutcome) => void }> },
	microsoft: SimulatedMicrosoft,
	mailbox: string,
	workers: number,
	stop: () => boolean
): Promise<void> {
	const worker = async (): Promise<void> => {
		while (!stop()) {
			const permit = await governor.acquire(mailbox);
			permit.release(await microsoft.call(mailbox));
		}
	};
	await Promise.all(Array.from({ length: workers }, worker));
}
