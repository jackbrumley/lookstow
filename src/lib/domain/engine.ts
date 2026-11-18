/** What the engine is doing right now, for the dashboard (browser-safe). */
export type EngineStatus = {
	phase: 'idle' | 'discovering' | 'syncing';
	paused: boolean;
	/** Why nothing is being backed up (not set up, discovery failing), or null. */
	problem: string | null;
	lastDiscoveryAt: string | null;
	nextDiscoveryAt: string | null;
	lastPassAt: string | null;
	nextPassAt: string | null;
	queued: number;
	syncing: {
		mailboxId: string;
		address: string;
		folder: string;
		stored: number;
		bytes: number;
		startedAt: string;
	}[];
};
