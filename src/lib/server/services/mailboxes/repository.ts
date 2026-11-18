import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, mailFolders, messages, runs } from '../../database/schema.ts';
import type { DiscoveredMailbox } from '../graph/discovery.ts';
import type { RunSummary } from '../../../domain/mailboxes.ts';

/** All SQL for mailboxes, their folders, stored messages and runs. */
export type MailboxRow = typeof mailboxes.$inferSelect;
export type FolderRow = typeof mailFolders.$inferSelect;

export function allMailboxes(db: Queryable): MailboxRow[] {
	return db.select().from(mailboxes).orderBy(mailboxes.address, mailboxes.kind).all();
}

export function mailboxById(db: Queryable, id: string): MailboxRow | undefined {
	return db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
}

/**
 * Applies one discovery: new mailboxes are added, known ones refreshed and un-gone, and any
 * known mailbox discovery no longer finds is marked gone (its backup stays).
 */
export function applyDiscovery(
	db: Queryable,
	found: readonly DiscoveredMailbox[],
	now: number
): { added: MailboxRow[]; gone: MailboxRow[]; returned: MailboxRow[] } {
	const at = new Date(now);
	const known = new Map(allMailboxes(db).map((row) => [`${row.userId}|${row.kind}`, row]));
	const added: MailboxRow[] = [];
	const returned: MailboxRow[] = [];
	const seen = new Set<string>();
	const primaryByUser = new Map<string, string>();

	// Primary mailboxes first, so archives can point at them.
	const ordered = [...found].sort(
		(a, b) => Number(a.kind === 'archive') - Number(b.kind === 'archive')
	);
	for (const mailbox of ordered) {
		const key = `${mailbox.userId}|${mailbox.kind}`;
		seen.add(key);
		const existing = known.get(key);
		const primaryMailboxId =
			mailbox.kind === 'archive' ? (primaryByUser.get(mailbox.userId) ?? null) : null;
		if (existing === undefined) {
			const row: MailboxRow = {
				id: randomUUID(),
				userId: mailbox.userId,
				kind: mailbox.kind,
				primaryMailboxId,
				exchangeMailboxId: mailbox.exchangeMailboxId,
				address: mailbox.address,
				displayName: mailbox.displayName,
				excluded: false,
				paused: false,
				firstSeenAt: at,
				lastSeenAt: at,
				goneAt: null,
				lastSyncStartedAt: null,
				lastSyncFinishedAt: null,
				lastSyncError: null,
				firstCopyDone: false,
				itemCount: 0,
				byteCount: 0
			};
			db.insert(mailboxes).values(row).run();
			added.push(row);
			if (mailbox.kind !== 'archive') {
				primaryByUser.set(mailbox.userId, row.id);
			}
			continue;
		}
		if (existing.goneAt !== null) {
			returned.push(existing);
		}
		db.update(mailboxes)
			.set({
				address: mailbox.address,
				displayName: mailbox.displayName,
				exchangeMailboxId: mailbox.exchangeMailboxId,
				primaryMailboxId: primaryMailboxId ?? existing.primaryMailboxId,
				lastSeenAt: at,
				goneAt: null
			})
			.where(eq(mailboxes.id, existing.id))
			.run();
		if (mailbox.kind !== 'archive') {
			primaryByUser.set(mailbox.userId, existing.id);
		}
	}

	const gone: MailboxRow[] = [];
	for (const [key, row] of known) {
		if (!seen.has(key) && row.goneAt === null) {
			db.update(mailboxes).set({ goneAt: at }).where(eq(mailboxes.id, row.id)).run();
			gone.push(row);
		}
	}
	return { added, gone, returned };
}

export function setExcluded(db: Queryable, id: string, excluded: boolean): void {
	db.update(mailboxes).set({ excluded }).where(eq(mailboxes.id, id)).run();
}

/** Forgets everything stored for a mailbox (its files are deleted by the caller). */
export function clearMailboxBackup(db: Queryable, id: string): void {
	db.delete(messages).where(eq(messages.mailboxId, id)).run();
	db.delete(mailFolders).where(eq(mailFolders.mailboxId, id)).run();
	db.update(mailboxes)
		.set({
			firstCopyDone: false,
			itemCount: 0,
			byteCount: 0,
			lastSyncStartedAt: null,
			lastSyncFinishedAt: null,
			lastSyncError: null
		})
		.where(eq(mailboxes.id, id))
		.run();
}

export function setMailboxPaused(db: Queryable, id: string, paused: boolean): void {
	db.update(mailboxes).set({ paused }).where(eq(mailboxes.id, id)).run();
}

export function markSyncStarted(db: Queryable, id: string, now: number): void {
	db.update(mailboxes)
		.set({ lastSyncStartedAt: new Date(now) })
		.where(eq(mailboxes.id, id))
		.run();
}

export function markSyncFinished(
	db: Queryable,
	id: string,
	now: number,
	outcome: { error: string | null; firstCopyDone: boolean }
): void {
	const totals = db
		.select({
			count: sql<number>`count(*)`,
			bytes: sql<number>`coalesce(sum(${messages.byteCount}), 0)`
		})
		.from(messages)
		.where(eq(messages.mailboxId, id))
		.get();
	db.update(mailboxes)
		.set({
			lastSyncFinishedAt: new Date(now),
			lastSyncError: outcome.error,
			firstCopyDone: outcome.firstCopyDone,
			itemCount: totals?.count ?? 0,
			byteCount: totals?.bytes ?? 0
		})
		.where(eq(mailboxes.id, id))
		.run();
}

export function foldersOf(db: Queryable, mailboxId: string): FolderRow[] {
	return db
		.select()
		.from(mailFolders)
		.where(eq(mailFolders.mailboxId, mailboxId))
		.orderBy(mailFolders.path)
		.all();
}

/** Brings the folder list in line with Graph's; folders that went away are marked, not deleted. */
export function syncFolderList(
	db: Queryable,
	mailboxId: string,
	current: readonly { graphId: string; path: string; storagePath: string }[],
	now: number
): FolderRow[] {
	const known = new Map(foldersOf(db, mailboxId).map((row) => [row.graphId, row]));
	const present = new Set<string>();
	for (const folder of current) {
		present.add(folder.graphId);
		const row = known.get(folder.graphId);
		if (row === undefined) {
			db.insert(mailFolders)
				.values({
					id: randomUUID(),
					mailboxId,
					graphId: folder.graphId,
					path: folder.path,
					storagePath: folder.storagePath,
					deltaLink: null,
					firstCopyDone: false,
					lastSyncedAt: null,
					goneAt: null
				})
				.run();
		} else if (row.path !== folder.path || row.goneAt !== null) {
			// A renamed folder keeps its storage path, so files already written stay where they are.
			db.update(mailFolders)
				.set({ path: folder.path, goneAt: null })
				.where(eq(mailFolders.id, row.id))
				.run();
		}
	}
	for (const row of known.values()) {
		if (!present.has(row.graphId) && row.goneAt === null) {
			db.update(mailFolders)
				.set({ goneAt: new Date(now) })
				.where(eq(mailFolders.id, row.id))
				.run();
		}
	}
	return foldersOf(db, mailboxId).filter((row) => row.goneAt === null);
}

export function saveFolderProgress(
	db: Queryable,
	folderId: string,
	progress: { deltaLink: string | null; firstCopyDone: boolean; now: number }
): void {
	db.update(mailFolders)
		.set({
			deltaLink: progress.deltaLink,
			firstCopyDone: progress.firstCopyDone,
			lastSyncedAt: new Date(progress.now)
		})
		.where(eq(mailFolders.id, folderId))
		.run();
}

export function storedMessage(db: Queryable, mailboxId: string, graphId: string) {
	return db
		.select({ id: messages.id, folderId: messages.folderId, deletedAt: messages.deletedAt })
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), eq(messages.graphId, graphId)))
		.get();
}

export type NewMessage = Omit<typeof messages.$inferInsert, 'id' | 'deletedAt'>;

export function insertMessage(db: Queryable, message: NewMessage): void {
	db.insert(messages)
		.values({ ...message, id: randomUUID(), deletedAt: null })
		.onConflictDoUpdate({
			target: [messages.mailboxId, messages.graphId],
			set: { ...message, deletedAt: null }
		})
		.run();
}

/** A message moved between folders: same file (it is the same message), new folder. */
export function moveMessage(db: Queryable, id: string, folderId: string): void {
	db.update(messages).set({ folderId, deletedAt: null }).where(eq(messages.id, id)).run();
}

/**
 * A folder's delta says the message left it. Only marked deleted when the message is still
 * filed under that folder: a message moved elsewhere also leaves its old folder, and the new
 * folder's delta files it there (immutable ids keep the id across the move).
 */
export function markMessageDeleted(
	db: Queryable,
	mailboxId: string,
	folderId: string,
	graphId: string,
	now: number
): boolean {
	return (
		db
			.update(messages)
			.set({ deletedAt: new Date(now) })
			.where(
				and(
					eq(messages.mailboxId, mailboxId),
					eq(messages.folderId, folderId),
					eq(messages.graphId, graphId),
					isNull(messages.deletedAt)
				)
			)
			.run().changes > 0
	);
}

export function folderItemCounts(db: Queryable, mailboxId: string): Map<string, number> {
	const rows = db
		.select({ folderId: messages.folderId, count: sql<number>`count(*)` })
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), isNull(messages.deletedAt)))
		.groupBy(messages.folderId)
		.all();
	return new Map(rows.map((row) => [row.folderId, row.count]));
}

// ---- Runs ----

export function startRun(
	db: Queryable,
	kind: 'discovery' | 'sync',
	mailboxId: string | null,
	now: number
): string {
	const id = randomUUID();
	db.insert(runs)
		.values({ id, kind, mailboxId, startedAt: new Date(now), outcome: 'running' })
		.run();
	return id;
}

export function finishRun(
	db: Queryable,
	id: string,
	result: {
		outcome: 'ok' | 'failed';
		added: number;
		removed: number;
		byteCount: number;
		error: string | null;
	},
	now: number
): void {
	db.update(runs)
		.set({ ...result, finishedAt: new Date(now) })
		.where(eq(runs.id, id))
		.run();
}

/** Runs a stop or crash left open are closed off at start-up. */
export function closeInterruptedRuns(db: Queryable, now: number): number {
	return db
		.update(runs)
		.set({ outcome: 'interrupted', finishedAt: new Date(now) })
		.where(eq(runs.outcome, 'running'))
		.run().changes;
}

export function recentRuns(
	db: Queryable,
	options: { limit: number; mailboxId?: string; kind?: 'discovery' | 'sync' }
): RunSummary[] {
	const conditions = [
		options.mailboxId === undefined ? undefined : eq(runs.mailboxId, options.mailboxId),
		options.kind === undefined ? undefined : eq(runs.kind, options.kind)
	].filter((condition) => condition !== undefined);
	return db
		.select({ run: runs, address: mailboxes.address })
		.from(runs)
		.leftJoin(mailboxes, eq(runs.mailboxId, mailboxes.id))
		.where(and(...conditions))
		.orderBy(desc(runs.startedAt))
		.limit(options.limit)
		.all()
		.map(({ run, address }) => ({
			id: run.id,
			kind: run.kind,
			mailboxId: run.mailboxId,
			mailboxAddress: address,
			startedAt: run.startedAt.toISOString(),
			finishedAt: run.finishedAt?.toISOString() ?? null,
			outcome: run.outcome,
			added: run.added,
			removed: run.removed,
			byteCount: run.byteCount,
			error: run.error
		}));
}
