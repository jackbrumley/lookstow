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
	/** Whether every compared folder matches Microsoft's count (SPEC-COMPLETENESS-REPAIR). */
	completeness: MailboxCompleteness;
};

/**
 * A mailbox's completeness: every compared folder matches or is explained; a gap Lookstow is
 * still checking (nothing to do); or a gap that outlasted a re-read by a day (needs a look).
 */
export type MailboxCompleteness = 'complete' | 'checking' | 'needs-look';

export const COMPLETENESS_LABELS: Record<Exclude<MailboxCompleteness, 'complete'>, string> = {
	checking: 'Incomplete: checking',
	'needs-look': 'Incomplete: needs a look'
};

/**
 * Why a folder's stored count and Microsoft's differ (docs/specs/SPEC-COMPLETENESS-REPAIR.md):
 * not compared (no count, or a hidden or non-mail folder), matching, explained (items waiting to
 * be copied again or given up on, and items that are not messages), or a gap nothing explains
 * yet: Checking until a re-read and a day have passed, then Needs a look. `recheckedAt` is the
 * re-read since the gap began, or null while it is still due.
 */
export type FolderGap =
	| { kind: 'unchecked' }
	| { kind: 'match' }
	| { kind: 'explained'; waiting: number; givenUp: number; otherItems: number }
	/**
	 * An auto-expanding archive's folder whose mail Microsoft counts in another part: checked
	 * against its last full listing (every week) instead of Microsoft's count.
	 */
	| { kind: 'from-listing'; listed: number | null; listedAt: string | null }
	| {
			kind: 'checking' | 'needs-look';
			stored: number;
			source: number;
			since: string;
			recheckedAt: string | null;
	  };

export type MailboxDetail = MailboxSummary & {
	userId: string;
	firstSeenAt: string;
	lastSeenAt: string;
	backupFolder: string;
	/** Online archive items the .fts reader could not read for Search (stored as they came). */
	unreadableItems: number;
	/** An online archive's parts (more than one: auto-expanding), or null. */
	archiveParts: number | null;
	folders: {
		path: string;
		itemCount: number;
		/** Microsoft's count after the folder's last up-to-date sync, or null before one. */
		sourceCount: number | null;
		/** How many items the folder's last full listing returned, and when, or null. */
		listedCount: number | null;
		listedAt: string | null;
		firstCopyDone: boolean;
		lastSyncedAt: string | null;
		gap: FolderGap;
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
