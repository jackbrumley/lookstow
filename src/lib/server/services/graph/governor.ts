/**
 * The throughput governor (docs/specs/SPEC-THROUGHPUT.md): every Graph request asks it for a
 * permit first and reports how it ended, so Lookstow copies as fast as Microsoft allows and no
 * faster. After SomeDrive's AdaptiveDownloadLimit:
 *
 * - **Lanes:** one per mailbox (found from the request's URL), at most `limit` requests in flight
 *   (Microsoft allows 4 per mailbox) and a request rate under its 10,000-per-10-minutes budget.
 *   A mailbox's own throttling (MailboxConcurrency) lowers only its lane.
 * - **App pace:** request starts a second (a token bucket) and requests in flight in total, both
 *   climbing slowly while they are what holds work back, cut to 85% of the refused rate when
 *   Microsoft throttles the app, held there 30 minutes, then probed upwards. One throttle burst
 *   is one cut, never a cascade.
 * - **Fairness:** waiting requests are served lane by lane in turn, so one huge mailbox never
 *   starves the others.
 *
 * Time and timers are injected, so tests drive it exactly.
 */

export type ThrottleScope = 'mailbox' | 'app';

export type RequestOutcome =
	| { kind: 'ok'; bytes: number; pressure: boolean }
	| { kind: 'throttled'; scope: ThrottleScope; retryAfterMs: number; code: string }
	| { kind: 'failed' };

export type Permit = {
	lane: string;
	startedAt: number;
	release: (outcome: RequestOutcome) => void;
};

/** Runs `run` after `ms`; returns a function that cancels it. */
export type Schedule = (ms: number, run: () => void) => () => void;

/** What the app pace has learned, kept between restarts. */
export type LearnedPace = {
	startsPerSecond: number;
	inFlightCap: number;
	/** The pace when Microsoft last refused, and when (ms since 1970). */
	ceiling: { startsPerSecond: number; inFlightCap: number; at: number } | null;
};

export const LANE = {
	start: 4,
	floor: 1,
	/** Probed above Microsoft's documented 4 only slowly, in case it allows more. */
	ceiling: 6,
	/** Under 10,000 requests per 10 minutes per mailbox. */
	startsPerSecond: 15,
	probeEveryMs: 10 * 60_000,
	/** A lane with nothing in flight or waiting for this long is forgotten. */
	idleMs: 10 * 60_000
} as const;

export const PACE = {
	startRate: 20,
	rateFloor: 2,
	rateCeiling: 400,
	startInFlight: 32,
	inFlightFloor: 4,
	inFlightCeiling: 256,
	/** Before the first refusal, one small step per interval while the pace is what holds work. */
	raiseEveryMs: 30_000,
	raiseStep: 0.05,
	/** Above the settle point, a smaller step per longer interval. */
	probeEveryMs: 60_000,
	probeStep: 0.02,
	/** A refusal sets the pace to this fraction of the refused one. */
	settle: 0.85,
	/** For this long after a refusal the pace holds flat. */
	holdMs: 30 * 60_000,
	/** A cut covers Microsoft's wait and this much grace. */
	cutGraceMs: 10_000,
	/** A new cut needs this many successes since the last one. */
	minSuccessesForCut: 20,
	/** Microsoft's early warning eases the rate by this factor, at most once per interval. */
	pressureEase: 0.8,
	pressureEveryMs: 30_000
} as const;

/** Seconds of per-second counters kept for rates (15 minutes). */
const HISTORY_SECONDS = 15 * 60;
const CHANGES_KEPT = 50;

type Counters = { requests: number; bytes: number; throttled: number; failed: number };

class Lane {
	readonly number: number;
	limit: number = LANE.start;
	inFlight = 0;
	tokens: number = LANE.startsPerSecond;
	refilledAt: number;
	lastChangeAt: number;
	lastThrottleAt: number | null = null;
	lastUsedAt: number;
	waiting = 0;
	/** The lane was full while requests waited, since its last change. */
	busy = false;
	requestsLastMinute: number[] = [];

	constructor(number: number, now: number) {
		this.number = number;
		this.refilledAt = now;
		this.lastChangeAt = now;
		this.lastUsedAt = now;
	}

	refill(now: number): void {
		const elapsed = Math.max(0, now - this.refilledAt) / 1000;
		this.refilledAt = now;
		this.tokens = Math.min(LANE.startsPerSecond, this.tokens + elapsed * LANE.startsPerSecond);
	}
}

type Waiter = { lane: string; resolve: (permit: Permit) => void };

export type PaceChange = {
	at: string;
	what: 'pace' | 'lane';
	lane: string | null;
	from: string;
	to: string;
	reason: string;
};

export type GovernorSnapshot = {
	pace: {
		startsPerSecond: number;
		inFlight: number;
		inFlightCap: number;
		phase: 'climbing' | 'holding' | 'probing';
		holdUntil: string | null;
		ceiling: { startsPerSecond: number; inFlightCap: number; at: string } | null;
		lastCut: { at: string; code: string; retryAfterMs: number } | null;
		/** Requests waiting because the app pace, not a lane, was full. */
		waitingForPace: number;
	};
	lanes: {
		name: string;
		limit: number;
		inFlight: number;
		waiting: number;
		requestsLastMinute: number;
		lastThrottleAt: string | null;
	}[];
	rates: Record<'last10Seconds' | 'lastMinute' | 'last15Minutes', Counters>;
	changes: PaceChange[];
};

/** Which mailbox a Graph URL is about: the lane key, or '' for requests about no mailbox. */
export function laneOf(url: string): string {
	const match =
		/\/(?:v1\.0|beta)\/users\/([^/?]+)\//i.exec(url) ??
		/\/admin\/exchange\/mailboxes\/([^/?]+)/i.exec(url);
	return match?.[1]?.toLowerCase() ?? '';
}

function iso(ms: number | null): string | null {
	return ms === null ? null : new Date(ms).toISOString();
}

const realSchedule: Schedule = (ms, run) => {
	const timer = setTimeout(run, ms);
	timer.unref();
	return () => {
		clearTimeout(timer);
	};
};

export class Governor {
	readonly #now: () => number;
	readonly #schedule: Schedule;
	#rate: number;
	#cap: number;
	#tokens: number;
	#refilledAt: number;
	#inFlight = 0;
	#lastChangeAt: number;
	#ceiling: LearnedPace['ceiling'];
	#holdUntil: number | null = null;
	#holdRate: number | null = null;
	#cutCoversUntil: number | null = null;
	#successesSinceCut: number | null = null;
	#lastPressureAt: number | null = null;
	#lastCut: { at: number; code: string; retryAfterMs: number } | null = null;
	/** The app pace held work back since its last change (so raising it can help). */
	#paceBound = false;
	#waitingForPace = 0;
	readonly #lanes = new Map<string, Lane>();
	#nextLaneNumber = 1;
	readonly #waiters: Waiter[] = [];
	#turn = 0;
	#wake: (() => void) | null = null;
	readonly #seconds = new Map<number, Counters>();
	readonly #changes: PaceChange[] = [];

	constructor(options: { now: () => number; schedule?: Schedule; learned?: LearnedPace | null }) {
		this.#now = options.now;
		this.#schedule = options.schedule ?? realSchedule;
		const now = options.now();
		const learned = options.learned ?? null;
		this.#rate = clamp(
			learned?.startsPerSecond ?? PACE.startRate,
			PACE.rateFloor,
			PACE.rateCeiling
		);
		this.#cap = Math.round(
			clamp(learned?.inFlightCap ?? PACE.startInFlight, PACE.inFlightFloor, PACE.inFlightCeiling)
		);
		this.#ceiling = learned?.ceiling ?? null;
		this.#tokens = this.#rate;
		this.#refilledAt = now;
		this.#lastChangeAt = now;
	}

	/** Waits until a request for `lane` may start, and returns its permit. */
	acquire(lane: string): Promise<Permit> {
		return new Promise((resolve) => {
			this.#waiters.push({ lane, resolve });
			if (lane !== '') this.#lane(lane).waiting += 1;
			this.#pump();
		});
	}

	learned(): LearnedPace {
		return { startsPerSecond: this.#rate, inFlightCap: this.#cap, ceiling: this.#ceiling };
	}

	/** Back to the first-run pace, as if nothing had been learned. */
	forget(): void {
		const now = this.#now();
		this.#record('pace', null, this.#paceText(), 'forgotten', now, () => {
			this.#rate = PACE.startRate;
			this.#cap = PACE.startInFlight;
			this.#ceiling = null;
			this.#holdUntil = null;
			this.#holdRate = null;
			this.#successesSinceCut = null;
			this.#lastChangeAt = now;
		});
		this.#pump();
	}

	/** Whether another mailbox would get more done now, and why not if it would not. */
	headroom(): { more: boolean; reason: string } {
		const now = this.#now();
		if (this.#lastCut !== null && now - this.#lastCut.at < 60_000) {
			return { more: false, reason: 'Microsoft asked Lookstow to slow down in the last minute' };
		}
		if (this.#waitingForPace > 0) {
			return { more: false, reason: 'Requests are waiting for the pace Microsoft allows' };
		}
		if (this.#inFlight >= this.#cap * 0.9) {
			return { more: false, reason: 'Requests in flight are near the cap' };
		}
		return { more: true, reason: '' };
	}

	snapshot(): GovernorSnapshot {
		const now = this.#now();
		this.#forgetIdleLanes(now);
		return {
			pace: {
				startsPerSecond: round(this.#rate),
				inFlight: this.#inFlight,
				inFlightCap: this.#cap,
				phase: this.#phase(now),
				holdUntil: this.#holdUntil !== null && now < this.#holdUntil ? iso(this.#holdUntil) : null,
				ceiling:
					this.#ceiling === null
						? null
						: {
								startsPerSecond: round(this.#ceiling.startsPerSecond),
								inFlightCap: this.#ceiling.inFlightCap,
								at: new Date(this.#ceiling.at).toISOString()
							},
				lastCut:
					this.#lastCut === null
						? null
						: {
								at: new Date(this.#lastCut.at).toISOString(),
								code: this.#lastCut.code,
								retryAfterMs: this.#lastCut.retryAfterMs
							},
				waitingForPace: this.#waitingForPace
			},
			lanes: [...this.#lanes.values()]
				.sort((a, b) => a.number - b.number)
				.map((lane) => ({
					name: `mailbox-${String(lane.number)}`,
					limit: lane.limit,
					inFlight: lane.inFlight,
					waiting: lane.waiting,
					requestsLastMinute: lane.requestsLastMinute.filter((at) => now - at < 60_000).length,
					lastThrottleAt: iso(lane.lastThrottleAt)
				})),
			rates: {
				last10Seconds: this.#sum(now, 10),
				lastMinute: this.#sum(now, 60),
				last15Minutes: this.#sum(now, HISTORY_SECONDS)
			},
			changes: [...this.#changes]
		};
	}

	#phase(now: number): 'climbing' | 'holding' | 'probing' {
		if (this.#holdUntil !== null && now < this.#holdUntil) return 'holding';
		return this.#ceiling === null ? 'climbing' : 'probing';
	}

	#lane(key: string): Lane {
		let lane = this.#lanes.get(key);
		if (lane === undefined) {
			lane = new Lane(this.#nextLaneNumber, this.#now());
			this.#nextLaneNumber += 1;
			this.#lanes.set(key, lane);
		}
		return lane;
	}

	#forgetIdleLanes(now: number): void {
		for (const [key, lane] of this.#lanes) {
			if (lane.inFlight === 0 && lane.waiting === 0 && now - lane.lastUsedAt > LANE.idleMs) {
				this.#lanes.delete(key);
			}
		}
	}

	#refill(now: number): void {
		const elapsed = Math.max(0, now - this.#refilledAt) / 1000;
		this.#refilledAt = now;
		this.#tokens = Math.min(Math.max(1, this.#rate), this.#tokens + elapsed * this.#rate);
	}

	/** Starts every waiting request that may start now, lane by lane in turn. */
	#pump(): void {
		const now = this.#now();
		this.#refill(now);
		this.#waitingForPace = 0;
		// When the next token is due, if a waiter is held back only by tokens.
		const soonest = { ms: Number.POSITIVE_INFINITY };
		const want = (ms: number): void => {
			soonest.ms = Math.min(soonest.ms, ms);
		};
		// Lanes in turn: start each pass after the lane served last.
		let granted = true;
		while (granted && this.#waiters.length > 0) {
			granted = false;
			const order = this.#waiterOrder();
			for (const index of order) {
				const waiter = this.#waiters[index];
				if (waiter === undefined) continue;
				const lane = waiter.lane === '' ? null : this.#lane(waiter.lane);
				if (lane !== null) {
					lane.refill(now);
					if (lane.inFlight >= lane.limit) {
						lane.busy = true;
						continue;
					}
					if (lane.tokens < 1) {
						want(((1 - lane.tokens) / LANE.startsPerSecond) * 1000);
						continue;
					}
				}
				if (this.#inFlight >= this.#cap || this.#tokens < 1) {
					this.#paceBound = true;
					this.#waitingForPace += 1;
					if (this.#tokens < 1) want(((1 - this.#tokens) / this.#rate) * 1000);
					continue;
				}
				this.#start(index, lane, now);
				granted = true;
				break;
			}
		}
		this.#wake?.();
		this.#wake = null;
		if (Number.isFinite(soonest.ms) && this.#waiters.length > 0) {
			this.#wake = this.#schedule(Math.max(1, Math.ceil(soonest.ms)), () => {
				this.#wake = null;
				this.#pump();
			});
		}
	}

	/** Indexes of waiters, starting with the lane after the one served last. */
	#waiterOrder(): number[] {
		const lanes = [...new Set(this.#waiters.map((waiter) => waiter.lane))];
		const start = lanes.length === 0 ? 0 : this.#turn % lanes.length;
		const rotated = [...lanes.slice(start), ...lanes.slice(0, start)];
		const order: number[] = [];
		for (const lane of rotated) {
			const index = this.#waiters.findIndex((waiter) => waiter.lane === lane);
			if (index >= 0) order.push(index);
		}
		return order;
	}

	#start(index: number, lane: Lane | null, now: number): void {
		const [waiter] = this.#waiters.splice(index, 1);
		if (waiter === undefined) return;
		this.#turn += 1;
		this.#tokens -= 1;
		this.#inFlight += 1;
		if (lane !== null) {
			lane.tokens -= 1;
			lane.inFlight += 1;
			lane.waiting = Math.max(0, lane.waiting - 1);
			lane.lastUsedAt = now;
			lane.requestsLastMinute = lane.requestsLastMinute.filter((at) => now - at < 60_000);
			lane.requestsLastMinute.push(now);
		}
		let released = false;
		waiter.resolve({
			lane: waiter.lane,
			startedAt: now,
			release: (outcome) => {
				if (released) return;
				released = true;
				this.#finish(lane, now, outcome);
			}
		});
	}

	#finish(lane: Lane | null, startedAt: number, outcome: RequestOutcome): void {
		const now = this.#now();
		this.#inFlight = Math.max(0, this.#inFlight - 1);
		if (lane !== null) {
			lane.inFlight = Math.max(0, lane.inFlight - 1);
			lane.lastUsedAt = now;
		}
		const second = this.#counters(now);
		second.requests += 1;
		if (outcome.kind === 'ok') {
			second.bytes += outcome.bytes;
			this.#onSuccess(lane, now, outcome.pressure);
		} else if (outcome.kind === 'throttled') {
			second.throttled += 1;
			if (outcome.scope === 'mailbox' && lane !== null) {
				this.#onLaneThrottle(lane, now);
			} else {
				this.#onAppThrottle(startedAt, now, outcome);
			}
		} else {
			second.failed += 1;
		}
		this.#pump();
	}

	#onSuccess(lane: Lane | null, now: number, pressure: boolean): void {
		if (this.#successesSinceCut !== null) this.#successesSinceCut += 1;
		if (pressure) this.#onPressure(now);
		if (lane !== null) this.#maybeRaiseLane(lane, now);
		this.#maybeRaisePace(now);
	}

	#maybeRaiseLane(lane: Lane, now: number): void {
		if (!lane.busy || lane.limit >= LANE.ceiling) return;
		if (now - lane.lastChangeAt < LANE.probeEveryMs) return;
		if (lane.lastThrottleAt !== null && now - lane.lastThrottleAt < LANE.probeEveryMs) return;
		const from = lane.limit;
		lane.limit += 1;
		lane.lastChangeAt = now;
		lane.busy = false;
		this.#log(
			'lane',
			`mailbox-${String(lane.number)}`,
			String(from),
			String(lane.limit),
			'full and unthrottled for 10 minutes',
			now
		);
	}

	#onLaneThrottle(lane: Lane, now: number): void {
		lane.lastThrottleAt = now;
		if (lane.limit <= LANE.floor) return;
		const from = lane.limit;
		lane.limit -= 1;
		lane.lastChangeAt = now;
		lane.busy = false;
		this.#log(
			'lane',
			`mailbox-${String(lane.number)}`,
			String(from),
			String(lane.limit),
			'Microsoft refused a request: too many at once for this mailbox',
			now
		);
	}

	#maybeRaisePace(now: number): void {
		const interval = this.#ceiling === null ? PACE.raiseEveryMs : PACE.probeEveryMs;
		if (!this.#paceBound || now - this.#lastChangeAt < interval) return;
		let rateCap: number = PACE.rateCeiling;
		let capCap: number = PACE.inFlightCeiling;
		let probing = false;
		if (this.#ceiling !== null) {
			const settleRate = this.#ceiling.startsPerSecond * PACE.settle;
			probing = this.#rate >= settleRate;
			if (this.#holdUntil !== null && now < this.#holdUntil) {
				rateCap = Math.min(rateCap, Math.max(PACE.rateFloor, this.#holdRate ?? this.#rate));
				capCap = Math.min(capCap, Math.max(this.#cap, this.#ceiling.inFlightCap));
			}
			if (!probing) rateCap = Math.min(rateCap, settleRate);
		}
		const step = probing ? PACE.probeStep : PACE.raiseStep;
		const nextRate = Math.max(this.#rate, Math.min(rateCap, this.#rate * (1 + step)));
		const nextCap = Math.max(
			this.#cap,
			Math.min(capCap, this.#cap + Math.max(1, Math.round(this.#cap * step)))
		);
		if (nextRate <= this.#rate && nextCap <= this.#cap) return;
		this.#record(
			'pace',
			null,
			this.#paceText(),
			probing ? 'probing upwards' : 'climbing while unthrottled',
			now,
			() => {
				this.#rate = nextRate;
				this.#cap = nextCap;
				this.#lastChangeAt = now;
				this.#paceBound = false;
			}
		);
	}

	#onAppThrottle(
		startedAt: number,
		now: number,
		outcome: { retryAfterMs: number; code: string }
	): void {
		const inPenalty = this.#cutCoversUntil !== null && startedAt <= this.#cutCoversUntil;
		const sameBurst =
			this.#successesSinceCut !== null && this.#successesSinceCut < PACE.minSuccessesForCut;
		if (inPenalty || sameBurst) return;
		const refusedRate = this.#rate;
		const refusedCap = this.#cap;
		this.#record(
			'pace',
			null,
			this.#paceText(),
			`Microsoft throttled the app (${outcome.code}, wait ${String(Math.round(outcome.retryAfterMs / 1000))} s)`,
			now,
			() => {
				this.#ceiling = { startsPerSecond: refusedRate, inFlightCap: refusedCap, at: now };
				this.#cutCoversUntil = now + outcome.retryAfterMs + PACE.cutGraceMs;
				this.#lastChangeAt = now + outcome.retryAfterMs;
				this.#holdUntil = now + PACE.holdMs;
				this.#holdRate = Math.max(PACE.rateFloor, refusedRate * PACE.settle);
				this.#successesSinceCut = 0;
				this.#lastCut = { at: now, code: outcome.code, retryAfterMs: outcome.retryAfterMs };
				this.#rate = Math.max(PACE.rateFloor, refusedRate * PACE.settle);
				this.#cap = Math.max(PACE.inFlightFloor, Math.floor(refusedCap * PACE.settle));
				this.#tokens = Math.min(this.#tokens, this.#rate);
			}
		);
	}

	#onPressure(now: number): void {
		const recently =
			this.#lastPressureAt !== null && now - this.#lastPressureAt < PACE.pressureEveryMs;
		const inPenalty = this.#cutCoversUntil !== null && now <= this.#cutCoversUntil;
		if (recently || inPenalty) return;
		this.#lastPressureAt = now;
		const before = this.#rate;
		const eased = Math.max(PACE.rateFloor, before * PACE.pressureEase);
		if (eased >= before) return;
		this.#record(
			'pace',
			null,
			this.#paceText(),
			'Microsoft warned that most of a limit is used',
			now,
			() => {
				this.#rate = eased;
				this.#tokens = Math.min(this.#tokens, eased);
				this.#lastChangeAt = now;
				this.#holdRate = eased;
				this.#holdUntil = now + PACE.holdMs;
				if (this.#ceiling === null || this.#ceiling.startsPerSecond > before) {
					this.#ceiling = { startsPerSecond: before, inFlightCap: this.#cap, at: now };
				}
			}
		);
	}

	#paceText(): string {
		return `${String(round(this.#rate))}/s, ${String(this.#cap)} in flight`;
	}

	#record(
		what: 'pace',
		lane: null,
		from: string,
		reason: string,
		now: number,
		change: () => void
	): void {
		change();
		this.#log(what, lane, from, this.#paceText(), reason, now);
	}

	#log(
		what: 'pace' | 'lane',
		lane: string | null,
		from: string,
		to: string,
		reason: string,
		now: number
	): void {
		this.#changes.push({ at: new Date(now).toISOString(), what, lane, from, to, reason });
		if (this.#changes.length > CHANGES_KEPT) this.#changes.shift();
	}

	#counters(now: number): Counters {
		const second = Math.floor(now / 1000);
		let counters = this.#seconds.get(second);
		if (counters === undefined) {
			counters = { requests: 0, bytes: 0, throttled: 0, failed: 0 };
			this.#seconds.set(second, counters);
			for (const key of this.#seconds.keys()) {
				if (key <= second - HISTORY_SECONDS) this.#seconds.delete(key);
			}
		}
		return counters;
	}

	#sum(now: number, seconds: number): Counters {
		const from = Math.floor(now / 1000) - seconds;
		const total: Counters = { requests: 0, bytes: 0, throttled: 0, failed: 0 };
		for (const [second, counters] of this.#seconds) {
			if (second <= from) continue;
			total.requests += counters.requests;
			total.bytes += counters.bytes;
			total.throttled += counters.throttled;
			total.failed += counters.failed;
		}
		return total;
	}
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

/** No pacing at all: for tests of code that makes Graph requests, and nothing else. */
export function unpacedGovernor(): Governor {
	return new Governor({
		now: Date.now,
		learned: {
			startsPerSecond: PACE.rateCeiling,
			inFlightCap: PACE.inFlightCeiling,
			ceiling: null
		},
		schedule: (_ms, run) => {
			const timer = setTimeout(run, 0);
			return () => {
				clearTimeout(timer);
			};
		}
	});
}

let shared: Governor | null = null;

/** The process's governor: every Graph client in the running service shares it. */
export function sharedGovernor(): Governor {
	shared ??= new Governor({ now: Date.now });
	return shared;
}

/** Sets what the shared governor starts from (the pace learned before a restart). */
export function startSharedGovernor(learned: LearnedPace | null): Governor {
	shared = new Governor({ now: Date.now, learned });
	return shared;
}
