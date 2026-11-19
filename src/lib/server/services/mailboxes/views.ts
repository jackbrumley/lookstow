import type { Queryable } from '../../database/connection.ts';
import { inScope } from '../engine/scope.ts';
import { readScope } from '../settings/settings.ts';
import {
	allMailboxes,
	folderItemCounts,
	foldersOf,
	mailboxById,
	mailboxesDifferingFromSource,
	recentRuns,
	unreadableItemCount,
	type MailboxRow
} from './repository.ts';
import { mailboxFolderName, resolveStoragePath } from '../storage/eml-store.ts';
import type { MailboxDetail, MailboxState, MailboxSummary } from '../../../domain/mailboxes.ts';
import type { ScopeSettings } from '../../../domain/settings.ts';

/** What the Mailboxes pages and the dashboard show, built from rows and the engine's live set. */
export function mailboxState(
	row: MailboxRow,
	scope: ScopeSettings,
	syncing: (id: string) => boolean
): MailboxState {
	if (row.goneAt !== null) {
		return 'gone';
	}
	if (row.excluded || scope.excludedAddresses.includes(row.address)) {
		return 'excluded';
	}
	if (!inScope(row, scope)) {
		return 'out-of-scope';
	}
	if (row.paused) {
		return 'paused';
	}
	if (syncing(row.id)) {
		return 'syncing';
	}
	if (row.lastSyncError !== null) {
		return 'failed';
	}
	return row.firstCopyDone ? 'backed-up' : 'waiting-first-copy';
}

function summary(row: MailboxRow, state: MailboxState, differs: boolean): MailboxSummary {
	return {
		id: row.id,
		address: row.address,
		displayName: row.displayName,
		kind: row.kind,
		state,
		lastSyncFinishedAt: row.lastSyncFinishedAt?.toISOString() ?? null,
		lastSyncError: row.lastSyncError,
		itemCount: row.itemCount,
		byteCount: row.byteCount,
		firstCopyDone: row.firstCopyDone,
		paused: row.paused,
		goneAt: row.goneAt?.toISOString() ?? null,
		differsFromMicrosoft: differs
	};
}

export function mailboxSummaries(
	db: Queryable,
	syncing: (id: string) => boolean
): MailboxSummary[] {
	const scope = readScope(db);
	const differing = mailboxesDifferingFromSource(db);
	return allMailboxes(db).map((row) =>
		summary(row, mailboxState(row, scope, syncing), differing.has(row.id))
	);
}

export function mailboxDetail(
	db: Queryable,
	id: string,
	backupRoot: string,
	syncing: (id: string) => boolean
): MailboxDetail | null {
	const row = mailboxById(db, id);
	if (row === undefined) {
		return null;
	}
	const counts = folderItemCounts(db, id);
	return {
		...summary(
			row,
			mailboxState(row, readScope(db), syncing),
			mailboxesDifferingFromSource(db).has(row.id)
		),
		userId: row.userId,
		firstSeenAt: row.firstSeenAt.toISOString(),
		lastSeenAt: row.lastSeenAt.toISOString(),
		backupFolder: resolveStoragePath(backupRoot, mailboxFolderName(row.address, row.kind)),
		unreadableItems: unreadableItemCount(db, id),
		folders: foldersOf(db, id)
			.filter((folder) => folder.goneAt === null)
			.map((folder) => ({
				path: folder.path,
				itemCount: counts.get(folder.id) ?? 0,
				sourceCount: folder.sourceCount,
				firstCopyDone: folder.firstCopyDone,
				lastSyncedAt: folder.lastSyncedAt?.toISOString() ?? null
			})),
		recentRuns: recentRuns(db, { limit: 20, mailboxId: id })
	};
}

/** Totals for the dashboard. */
export function mailboxTotals(summaries: readonly MailboxSummary[]) {
	const count = (state: MailboxState) => summaries.filter((s) => s.state === state).length;
	return {
		mailboxes: summaries.length,
		backedUp: count('backed-up'),
		waiting: count('waiting-first-copy'),
		syncing: count('syncing'),
		failed: count('failed'),
		excluded: count('excluded') + count('out-of-scope'),
		gone: count('gone'),
		differingFromMicrosoft: summaries.filter((s) => s.differsFromMicrosoft).length,
		items: summaries.reduce((sum, s) => sum + s.itemCount, 0),
		bytes: summaries.reduce((sum, s) => sum + s.byteCount, 0)
	};
}
