/** What the engine is doing right now, for the dashboard and the page frame (browser-safe). */
export type DiskStatus = {
	/** The backup folder that was measured. */
	path: string;
	totalBytes: number | null;
	freeBytes: number | null;
	usedPercent: number | null;
	/** ok, warn (from warnPercent), full (from pausePercent: syncs pause), unknown. */
	level: 'ok' | 'warn' | 'full' | 'unknown';
	warnPercent: number;
	pausePercent: number;
};

type PauseState =
	{ paused: false } | { paused: true; reason: 'manual' | 'disk'; since: string | null };

export type EngineStatus = {
	pause: PauseState;
	/** Why nothing is being backed up (not set up, discovery failing), or null. */
	problem: string | null;
	discovery: {
		running: boolean;
		/** While running: users checked of all users, and mailboxes found so far. */
		progress: { usersTotal: number | null; usersChecked: number; found: number } | null;
		lastAt: string | null;
		/** Null while paused or running. */
		nextAt: string | null;
	};
	/** Mailboxes syncing now. */
	syncing: {
		mailboxId: string;
		address: string;
		folder: string;
		stored: number;
		bytes: number;
		startedAt: string;
		firstCopy: boolean;
	}[];
	/** Mailboxes waiting for a free slot, by queue. */
	waiting: {
		requested: number;
		due: number;
		firstCopy: number;
		/** Up to date: waiting for their sync interval. */
		later: number;
		nextDueAt: string | null;
	};
	/** Mailboxes synced at once now (adjusted to Graph's throttling) and the setting's maximum. */
	slots: { current: number; maximum: number };
	/** Download rates over the last minute and the last 15 minutes. */
	rates: {
		lastMinute: { bytesPerSecond: number; messagesPerSecond: number };
		last15Minutes: { bytesPerSecond: number; messagesPerSecond: number };
	};
	/** Replies where Graph asked Lookstow to slow down, in the last minute and 15 minutes. */
	throttled: { lastMinute: number; last15Minutes: number };
	disk: DiskStatus;
	/** While files stored before 0.4.0 move into the date layout: how far it is. Syncs wait. */
	relayout: { total: number; moved: number; problems: number } | null;
};
