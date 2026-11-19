/** Browser-safe shapes for the Mailboxes pages and the dashboard. */

/** What the console says a mailbox is doing, from its row and the engine's live state. */
export type MailboxState =
	| 'syncing'
	| 'waiting-first-copy'
	| 'backed-up'
	| 'failed'
	| 'paused'
	| 'excluded'
	| 'out-of-scope'
	| 'gone';

export type MailboxSummary = {
	id: string;
	address: string;
	displayName: string;
	kind: string;
	state: MailboxState;
	lastSyncFinishedAt: string | null;
	lastSyncError: string | null;
	itemCount: number;
	byteCount: number;
	firstCopyDone: boolean;
	paused: boolean;
	goneAt: string | null;
};

export type MailboxDetail = MailboxSummary & {
	userId: string;
	firstSeenAt: string;
	lastSeenAt: string;
	backupFolder: string;
	/** Online archive items the .fts reader could not read for Search (stored as they came). */
	unreadableItems: number;
	folders: {
		path: string;
		itemCount: number;
		firstCopyDone: boolean;
		lastSyncedAt: string | null;
	}[];
	recentRuns: RunSummary[];
};

export type RunSummary = {
	id: string;
	kind: 'discovery' | 'sync';
	mailboxId: string | null;
	mailboxAddress: string | null;
	startedAt: string;
	finishedAt: string | null;
	outcome: 'running' | 'ok' | 'failed' | 'interrupted';
	added: number;
	removed: number;
	byteCount: number;
	error: string | null;
};

/** Words for each kind, as the console shows them. */
export const KIND_LABELS: Record<string, string> = {
	user: 'User',
	shared: 'Shared',
	room: 'Room',
	equipment: 'Equipment',
	linked: 'Linked',
	others: 'Other',
	archive: 'Online archive'
};

export const STATE_LABELS: Record<MailboxState, string> = {
	syncing: 'Syncing now',
	'waiting-first-copy': 'Waiting for first copy',
	'backed-up': 'Backed up',
	failed: 'Last sync failed',
	paused: 'Paused',
	excluded: 'Excluded',
	'out-of-scope': 'Not in scope',
	gone: 'Gone from Microsoft 365'
};
