/**
 * The throughput governor's numbers as the console shows them (docs/specs/SPEC-THROUGHPUT.md
 * 4.6 and 4.7): browser-safe, and naming no mailbox, person or message (lanes are numbers).
 */
export type Counters = { requests: number; bytes: number; throttled: number; failed: number };

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
		phase: 'idle' | 'climbing' | 'holding' | 'probing';
		holdUntil: string | null;
		/** Microsoft asked every request to wait until then. */
		pausedUntil: string | null;
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

/** The service's own counts beside the governor's. */
export type ThroughputService = {
	engine: {
		paused: boolean;
		mailboxesSyncing: number;
		firstCopiesSyncing: number;
		slots: { current: number; maximum: number };
		waiting: { requested: number; due: number; firstCopy: number; later: number };
		messagesStoredBySyncsRunning: number;
		bytesStoredBySyncsRunning: number;
	};
	rates: {
		lastMinute: { bytesPerSecond: number; messagesPerSecond: number };
		last15Minutes: { bytesPerSecond: number; messagesPerSecond: number };
	};
	throttled: { lastMinute: number; last15Minutes: number };
	disk: { usedPercent: number | null; level: string };
	memory: { rssBytes: number; heapUsedBytes: number };
};

/** Everything about speed at one moment: GET /api/throughput and the dashboard's Speed block. */
export type ThroughputView = GovernorSnapshot & {
	at: string;
	service: ThroughputService;
	/** Whether another mailbox would get more done now, and why not. */
	headroom: { more: boolean; reason: string };
};
