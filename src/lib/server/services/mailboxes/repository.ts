import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, mailFolders, messageEvents, messages, runs } from '../../database/schema.ts';
import type { DiscoveredMailbox } from '../graph/discovery.ts';
import { refreshHeaders, restartHeaders } from '../search-index/headers.ts';
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
	db.delete(messageEvents).where(eq(messageEvents.mailboxId, id)).run();
	db.delete(messages).where(eq(messages.mailboxId, id)).run();
	// SQLite may give new messages the row numbers just freed: the index walks every message again.
	restartHeaders(db);
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
	db.update(mailboxes)
		.set({
			lastSyncFinishedAt: new Date(now),
			lastSyncError: outcome.error,
			firstCopyDone: outcome.firstCopyDone
		})
		.where(eq(mailboxes.id, id))
		.run();
}

/**
 * A mailbox's item count and size are the stored messages, nothing else. insertMessage and
 * clearMailboxBackup keep them in step as they change those rows; this sets every mailbox from
 * the rows themselves, so a count left wrong (by an older version, or a crash between the two
 * writes) is corrected at start-up. Returns how many mailboxes it corrected.
 */
export function recountStoredMessages(db: Queryable): number {
	const stored = sql`(select count(*) from ${messages} where ${messages.mailboxId} = ${mailboxes.id})`;
	const bytes = sql`(select coalesce(sum(${messages.byteCount}), 0) from ${messages} where ${messages.mailboxId} = ${mailboxes.id})`;
	return db
		.update(mailboxes)
		.set({ itemCount: stored, byteCount: bytes })
		.where(sql`${mailboxes.itemCount} <> ${stored} or ${mailboxes.byteCount} <> ${bytes}`)
		.run().changes;
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
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			folderId: messages.folderId,
			deletedAt: messages.deletedAt,
			leftAt: messages.leftAt
		})
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), eq(messages.graphId, graphId)))
		.get();
}

export type NewMessage = Omit<
	typeof messages.$inferInsert,
	'id' | 'deletedAt' | 'leftAt' | 'archiveCopyId'
>;

function folderPathOf(db: Queryable, folderId: string): string | null {
	return (
		db
			.select({ path: mailFolders.path })
			.from(mailFolders)
			.where(eq(mailFolders.id, folderId))
			.get()?.path ?? null
	);
}

function recordEvent(db: Queryable, event: Omit<typeof messageEvents.$inferInsert, 'id'>): void {
	db.insert(messageEvents)
		.values({ ...event, id: randomUUID() })
		.run();
}

/**
 * A message stored for the first time: its row, a `stored` event naming its folder, and its
 * mailbox's count and size, in one transaction so the count never misses a stored message.
 */
export function insertMessage(db: Queryable, message: NewMessage): string {
	const id = randomUUID();
	db.transaction((tx) => {
		tx.insert(messages)
			.values({ ...message, id, deletedAt: null })
			.run();
		tx.update(mailboxes)
			.set({
				itemCount: sql`${mailboxes.itemCount} + 1`,
				byteCount: sql`${mailboxes.byteCount} + ${message.byteCount}`
			})
			.where(eq(mailboxes.id, message.mailboxId))
			.run();
		recordEvent(tx, {
			messageId: id,
			mailboxId: message.mailboxId,
			at: message.storedAt,
			kind: 'stored',
			fromFolderPath: null,
			toFolderPath: folderPathOf(tx, message.folderId)
		});
	});
	return id;
}

/**
 * A message moved between folders, or came back after being deleted: same file (the files never
 * move), new folder in the index, and the move in its history.
 */
export function moveMessage(
	db: Queryable,
	message: {
		id: string;
		mailboxId: string;
		folderId: string;
		deletedAt: Date | null;
		leftAt: Date | null;
	},
	toFolderId: string,
	now: number
): void {
	db.update(messages)
		.set({ folderId: toFolderId, deletedAt: null, leftAt: null })
		.where(eq(messages.id, message.id))
		.run();
	recordEvent(db, {
		messageId: message.id,
		mailboxId: message.mailboxId,
		at: new Date(now),
		kind: message.deletedAt === null && message.leftAt === null ? 'moved' : 'restored',
		fromFolderPath: folderPathOf(db, message.folderId),
		toFolderPath: folderPathOf(db, toFolderId)
	});
}

/** Each mailbox's folders, and how many of them have finished their first copy (the dashboard). */
export function firstCopyProgress(db: Queryable): Map<string, { done: number; total: number }> {
	const rows = db
		.select({
			mailboxId: mailFolders.mailboxId,
			total: sql<number>`count(*)`,
			done: sql<number>`coalesce(sum(${mailFolders.firstCopyDone}), 0)`
		})
		.from(mailFolders)
		.where(isNull(mailFolders.goneAt))
		.groupBy(mailFolders.mailboxId)
		.all();
	return new Map(rows.map((row) => [row.mailboxId, { done: row.done, total: row.total }]));
}

export function folderItemCounts(db: Queryable, mailboxId: string): Map<string, number> {
	const rows = db
		.select({ folderId: messages.folderId, count: sql<number>`count(*)` })
		.from(messages)
		.where(
			and(eq(messages.mailboxId, mailboxId), isNull(messages.deletedAt), isNull(messages.leftAt))
		)
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

/**
 * Online archive items with nothing to search them by: stored before Lookstow could read them,
 * or not readable by an earlier version. Items this version already failed to read are left out.
 */
export function archiveItemsToIndex(db: Queryable, version: string) {
	return db
		.select({ id: messages.id, filePath: messages.filePath, receivedAt: messages.receivedAt })
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.where(
			and(
				eq(mailboxes.kind, 'archive'),
				eq(messages.subject, ''),
				eq(messages.sender, ''),
				isNull(messages.internetMessageId),
				like(messages.filePath, '%.fts'),
				or(isNull(messages.indexFailedVersion), ne(messages.indexFailedVersion, version))
			)
		)
		.all();
}

/** Records that this version could not read the item, so it is not read again until an update. */
export function markIndexFailed(db: Queryable, id: string, version: string): void {
	db.update(messages).set({ indexFailedVersion: version }).where(eq(messages.id, id)).run();
}

/** How many of a mailbox's archive items could not be read for Search. */
export function unreadableItemCount(db: Queryable, mailboxId: string): number {
	return (
		db
			.select({ count: sql<number>`count(*)` })
			.from(messages)
			.where(and(eq(messages.mailboxId, mailboxId), isNotNull(messages.indexFailedVersion)))
			.get()?.count ?? 0
	);
}

/** Fills in what Search finds a message by; the stored file is not touched. */
export function setMessageIndex(
	db: Queryable,
	id: string,
	index: {
		subject: string;
		sender: string;
		recipients: string;
		internetMessageId: string | null;
		receivedAt: Date | null;
	}
): void {
	db.update(messages)
		.set({ ...index, indexFailedVersion: null })
		.where(eq(messages.id, id))
		.run();
	refreshHeaders(db, id, index);
}

/** The ids of a folder's stored messages still in it (not deleted, not left). */
export function liveMessageIds(db: Queryable, folderId: string): string[] {
	return db
		.select({ graphId: messages.graphId })
		.from(messages)
		.where(
			and(eq(messages.folderId, folderId), isNull(messages.deletedAt), isNull(messages.leftAt))
		)
		.all()
		.map((row) => row.graphId);
}

// ---- The backup folder as a whole ----

/**
 * One stored file's path (the last one stored), to show a folder without a marker holds this
 * backup. Row order is the order of storing, and needs no sort of every message.
 */
export function newestStoredPath(db: Queryable): string | null {
	return (
		db
			.select({ filePath: messages.filePath })
			.from(messages)
			.orderBy(desc(sql`${messages}.rowid`))
			.limit(1)
			.get()?.filePath ?? null
	);
}

/** Every stored file the index knows, with its SHA-256, for checking a moved copy. */
export function storedFileHashes(db: Queryable): Map<string, string> {
	const rows = db
		.select({ filePath: messages.filePath, sha256: messages.sha256 })
		.from(messages)
		.all();
	return new Map(rows.map((row) => [row.filePath, row.sha256]));
}

/**
 * How many files the index holds, and their bytes: the sum of each mailbox's count and size,
 * which are kept with every stored message, instead of counting every message.
 */
export function storedTotals(db: Queryable): { files: number; bytes: number } {
	const row = db
		.select({
			files: sql<number>`coalesce(sum(${mailboxes.itemCount}), 0)`,
			bytes: sql<number>`coalesce(sum(${mailboxes.byteCount}), 0)`
		})
		.from(mailboxes)
		.get();
	return { files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
}
