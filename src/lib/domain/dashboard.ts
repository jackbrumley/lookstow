import type { ActivityEntry } from './activity.ts';
import type { MailboxSummary } from './mailboxes.ts';

/**
 * What the dashboard says, worked out once (docs/specs/SPEC-STATUS.md). The tiles are lasting
 * facts that change only when something really changes: a mailbox counts as fully copied from
 * its first complete copy on, whether it is syncing or its last sync failed. What is happening
 * now (syncing, a failed sync) is shown apart from them.
 */
export type FirstCopy = {
	id: string;
	address: string;
	kind: string;
	foldersDone: number;
	foldersTotal: number;
	syncing: boolean;
};

export type Attention = {
	id: string;
	address: string;
	kind: string;
	problem: string;
	what: string;
};

export type DashboardOverview = {
	/** Mailboxes Lookstow backs up (in scope, not excluded, still in Microsoft 365). */
	inBackup: number;
	/** Every mailbox discovery found. */
	found: number;
	fullyCopied: number;
	paused: number;
	firstCopies: FirstCopy[];
	attention: Attention[];
	storedBytes: number;
	storedItems: number;
};

export type FolderProgress = Map<string, { done: number; total: number }>;

const NOT_BACKED_UP = new Set(['out-of-scope', 'excluded', 'gone']);

export function dashboardOverview(
	summaries: readonly MailboxSummary[],
	folders: FolderProgress
): DashboardOverview {
	const inBackup = summaries.filter((mailbox) => !NOT_BACKED_UP.has(mailbox.state));
	const attention: Attention[] = [];
	for (const mailbox of inBackup) {
		if (mailbox.state === 'failed') {
			attention.push({
				id: mailbox.id,
				address: mailbox.address,
				kind: mailbox.kind,
				problem: `Its last sync failed: ${mailbox.lastSyncError ?? 'no reason given'}`,
				what: 'Lookstow tries again by itself, less often each time. Open it for its recent runs.'
			});
		} else if (mailbox.completeness === 'needs-look') {
			attention.push({
				id: mailbox.id,
				address: mailbox.address,
				kind: mailbox.kind,
				problem: 'A folder still differs from Microsoft a day after Lookstow read it again.',
				what: 'Open it to see which folder, and its items that could not be copied.'
			});
		}
	}
	return {
		inBackup: inBackup.length,
		found: summaries.length,
		fullyCopied: inBackup.filter((mailbox) => mailbox.firstCopyDone).length,
		paused: inBackup.filter((mailbox) => mailbox.state === 'paused').length,
		firstCopies: inBackup
			.filter((mailbox) => !mailbox.firstCopyDone)
			.map((mailbox) => ({
				id: mailbox.id,
				address: mailbox.address,
				kind: mailbox.kind,
				foldersDone: folders.get(mailbox.id)?.done ?? 0,
				foldersTotal: folders.get(mailbox.id)?.total ?? 0,
				syncing: mailbox.state === 'syncing'
			})),
		attention,
		storedBytes: summaries.reduce((sum, mailbox) => sum + mailbox.byteCount, 0),
		storedItems: summaries.reduce((sum, mailbox) => sum + mailbox.itemCount, 0)
	};
}

/**
 * Recent errors, split: those about a mailbox that still needs attention, and earlier ones that
 * have cleared since (its later syncs worked), so a list of old failures does not read as now.
 */
export function splitProblems(
	problems: readonly ActivityEntry[],
	attention: readonly Attention[]
): { open: ActivityEntry[]; cleared: ActivityEntry[] } {
	const needing = new Set(attention.map((item) => item.id));
	return {
		open: problems.filter((entry) => entry.mailboxId !== null && needing.has(entry.mailboxId)),
		cleared: problems.filter((entry) => entry.mailboxId === null || !needing.has(entry.mailboxId))
	};
}
