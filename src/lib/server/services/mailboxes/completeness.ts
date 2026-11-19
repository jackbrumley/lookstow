import { and, count, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { itemFailures, mailboxes, mailFolders, messages } from '../../database/schema.ts';
import { recordActivity } from '../activity/activity.ts';
import type { FolderGap } from '../../../domain/mailboxes.ts';

/**
 * The completeness check and its repair (docs/specs/SPEC-COMPLETENESS-REPAIR.md). After each
 * folder syncs, Microsoft's count is compared with the stored messages. A gap that items waiting
 * to be copied again explain is not a difference. A gap nothing explains is recorded with the
 * time it was first seen; if it lasts, the folder is read again from the start (at most once a
 * day), and if it still lasts a day, an activity entry (and so an alert) says so.
 */

/** A gap must outlast this (about two routine syncs) before the folder is read again. */
export const RECHECK_AFTER_MS = 30 * 60_000;
/** A folder is read again from the start at most this often. */
const RECHECK_EVERY_MS = 24 * 3_600_000;
/** A gap that outlasts a re-read by this much is reported. */
export const REPORT_AFTER_MS = 24 * 3_600_000;

/**
 * Why a folder's stored count and Microsoft's differ, or that they do not. Microsoft's count
 * can be higher by the items waiting to be copied again (or given up on) and by the items that
 * are not messages, which the last full listing measured; anything else is unexplained.
 */
export function explainGap(
	stored: number,
	source: number | null,
	failures: { waiting: number; givenUp: number },
	otherItems: number | null
): FolderGap {
	if (source === null) return { kind: 'unchecked' };
	if (source === stored) return { kind: 'match' };
	const accounted = failures.waiting + failures.givenUp + (otherItems ?? 0);
	if (source > stored && source - stored <= accounted) {
		return {
			kind: 'explained',
			waiting: failures.waiting,
			givenUp: failures.givenUp,
			otherItems: otherItems ?? 0
		};
	}
	return { kind: 'unexplained', stored, source };
}

/** Each folder's stored messages still in it at the source (not deleted, not archived). */
function storedCount(db: Queryable, folderId: string): number {
	return (
		db
			.select({ total: count() })
			.from(messages)
			.where(
				and(eq(messages.folderId, folderId), isNull(messages.deletedAt), isNull(messages.leftAt))
			)
			.get()?.total ?? 0
	);
}

/** Items in each folder of a mailbox that could not be copied: still being tried, or given up. */
export function folderFailures(
	db: Queryable,
	mailboxId: string
): Map<string, { waiting: number; givenUp: number }> {
	const rows = db
		.select({ folderId: itemFailures.folderId, terminal: itemFailures.terminal, total: count() })
		.from(itemFailures)
		.where(eq(itemFailures.mailboxId, mailboxId))
		.groupBy(itemFailures.folderId, itemFailures.terminal)
		.all();
	const byFolder = new Map<string, { waiting: number; givenUp: number }>();
	for (const row of rows) {
		const entry = byFolder.get(row.folderId) ?? { waiting: 0, givenUp: 0 };
		if (row.terminal) entry.givenUp += row.total;
		else entry.waiting += row.total;
		byFolder.set(row.folderId, entry);
	}
	return byFolder;
}

/**
 * Microsoft's count for each folder whose sync just reached its delta link, read after that
 * sync: saved, compared with the stored messages, and the folder's difference started or
 * cleared. `listed` is how many messages a full listing of the folder returned in this sync
 * (a re-read from the start), or null: the rest of Microsoft's count is items that are not
 * messages.
 */
export function recordFolderCounts(
	db: Queryable,
	mailboxId: string,
	counts: readonly { folderId: string; count: number; listed: number | null }[],
	now: number
): void {
	const failures = folderFailures(db, mailboxId);
	for (const { folderId, count: source, listed } of counts) {
		const folder = db.select().from(mailFolders).where(eq(mailFolders.id, folderId)).get();
		if (folder === undefined) continue;
		const otherItems = listed === null ? folder.otherItemCount : Math.max(0, source - listed);
		const gap = explainGap(
			storedCount(db, folderId),
			source,
			failures.get(folderId) ?? { waiting: 0, givenUp: 0 },
			otherItems
		);
		const differs = gap.kind === 'unexplained';
		db.update(mailFolders)
			.set({
				sourceCount: source,
				sourceCountAt: new Date(now),
				otherItemCount: otherItems,
				differsSince: differs ? (folder.differsSince ?? new Date(now)) : null,
				differenceAlertedAt: differs ? folder.differenceAlertedAt : null
			})
			.where(eq(mailFolders.id, folderId))
			.run();
	}
}

/** Whether this folder's difference has lasted long enough to read it again from the start. */
export function recheckDue(
	folder: { differsSince: Date | null; recheckedAt: Date | null },
	now: number
): boolean {
	return (
		folder.differsSince !== null &&
		now - folder.differsSince.getTime() >= RECHECK_AFTER_MS &&
		(folder.recheckedAt === null || now - folder.recheckedAt.getTime() >= RECHECK_EVERY_MS)
	);
}

/** Records that the folder is being read again from the start, and says so in the activity log. */
export function startRecheck(
	db: Queryable,
	folder: { id: string; mailboxId: string; path: string },
	address: string,
	now: number
): void {
	db.update(mailFolders)
		.set({ recheckedAt: new Date(now) })
		.where(eq(mailFolders.id, folder.id))
		.run();
	recordActivity(db, {
		level: 'info',
		kind: 'completeness',
		actor: 'system',
		mailboxId: folder.mailboxId,
		summary: `${address}: reading ${folder.path} again from the start`,
		detail:
			'Its stored messages have differed from Microsoft’s count for more than half an hour, and no item waiting to be copied again explains it. Lookstow lists the whole folder, copies what is missing and records what is gone. Messages already stored are not downloaded again.'
	});
}

/** Mailboxes with a folder that differs from Microsoft's count with nothing to explain it. */
export function mailboxesDifferingFromSource(db: Queryable): Set<string> {
	const rows = db
		.selectDistinct({ mailboxId: mailFolders.mailboxId })
		.from(mailFolders)
		.where(and(isNotNull(mailFolders.differsSince), isNull(mailFolders.goneAt)))
		.all();
	return new Set(rows.map((row) => row.mailboxId));
}

/**
 * Reports, once, each folder of this mailbox whose difference has lasted a day and survived a
 * re-read from the start: an error in the activity log, which the alert rules email.
 */
export function reportLastingDifferences(db: Queryable, mailboxId: string, now: number): number {
	const lasting = db
		.select({
			id: mailFolders.id,
			path: mailFolders.path,
			sourceCount: mailFolders.sourceCount,
			differsSince: mailFolders.differsSince,
			address: mailboxes.address
		})
		.from(mailFolders)
		.innerJoin(mailboxes, eq(mailboxes.id, mailFolders.mailboxId))
		.where(
			and(
				eq(mailFolders.mailboxId, mailboxId),
				isNull(mailFolders.goneAt),
				isNull(mailFolders.differenceAlertedAt),
				lte(mailFolders.differsSince, new Date(now - REPORT_AFTER_MS)),
				isNotNull(mailFolders.recheckedAt),
				gte(mailFolders.recheckedAt, sql`${mailFolders.differsSince}`)
			)
		)
		.all();
	for (const folder of lasting) {
		const stored = storedCount(db, folder.id);
		recordActivity(db, {
			level: 'error',
			kind: 'completeness',
			actor: 'system',
			mailboxId,
			summary: `${folder.address}: ${folder.path} still differs from Microsoft’s count after a day`,
			detail: `Lookstow holds ${String(stored)} messages in this folder; Microsoft says ${String(folder.sourceCount ?? 0)}. Reading the folder again from the start did not close the gap. Open the mailbox in Lookstow to see the folder, and check its failed items and the activity log for this mailbox.`
		});
		db.update(mailFolders)
			.set({ differenceAlertedAt: new Date(now) })
			.where(eq(mailFolders.id, folder.id))
			.run();
	}
	return lasting.length;
}
