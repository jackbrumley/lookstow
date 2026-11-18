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

export type PauseState =
	{ paused: false } | { paused: true; reason: 'manual' | 'disk'; since: string | null };

export type EngineStatus = {
	pause: PauseState;
	/** Why nothing is being backed up (not set up, discovery failing), or null. */
	problem: string | null;
	discovery: {
		running: boolean;
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
	waiting: { requested: number; due: number; firstCopy: number };
	slots: number;
	disk: DiskStatus;
};
