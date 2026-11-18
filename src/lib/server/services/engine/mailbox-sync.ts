import type { Queryable } from '../../database/connection.ts';
import { GraphError, PER_MAILBOX_CONCURRENCY, type GraphClient } from '../graph/client.ts';
import { forEachLimited } from '../graph/discovery.ts';
import { folderChanges, listFolders, messageMime, type MessageChange } from '../graph/mail.ts';
import {
	insertMessage,
	markMessageDeleted,
	moveMessage,
	saveFolderProgress,
	storedMessage,
	syncFolderList,
	type FolderRow,
	type MailboxRow
} from '../mailboxes/repository.ts';
import {
	folderStoragePath,
	mailboxFolderName,
	messageFileName,
	resolveStoragePath,
	writeMessageFile
} from '../storage/eml-store.ts';

/**
 * One sync of one primary mailbox: refresh the folder list, then run each folder's delta query
 * from where the last sync stopped, storing every new message as .eml and recording messages
 * the source deleted (their files stay). Progress is saved after every page, so a stop or crash
 * in the middle of a 50 GB first copy loses at most one page.
 */
export type SyncContext = {
	db: Queryable;
	client: GraphClient;
	backupRoot: string;
	now: () => number;
	/** Set when the service is stopping: the sync ends after the current page. */
	stopping: () => boolean;
	/** Live progress for the console. */
	progress: (update: { folder: string; stored: number; bytes: number }) => void;
};

export type SyncOutcome = {
	added: number;
	removed: number;
	byteCount: number;
	firstCopyDone: boolean;
	stoppedEarly: boolean;
};

export class StopRequested extends Error {
	override name = 'StopRequested';
}

export async function syncMailbox(context: SyncContext, mailbox: MailboxRow): Promise<SyncOutcome> {
	if (mailbox.kind === 'archive') {
		throw new Error('Copying online archives is not built yet');
	}
	const graphFolders = await listFolders(context.client, mailbox.userId);
	const folders = syncFolderList(
		context.db,
		mailbox.id,
		withUniqueStoragePaths(graphFolders),
		context.now()
	);
	const mailboxRoot = mailboxFolderName(mailbox.address, mailbox.kind);
	const totals: SyncOutcome = {
		added: 0,
		removed: 0,
		byteCount: 0,
		firstCopyDone: true,
		stoppedEarly: false
	};
	for (const folder of folders) {
		if (context.stopping()) {
			totals.stoppedEarly = true;
			totals.firstCopyDone = false;
			break;
		}
		const done = await syncFolder(context, mailbox, mailboxRoot, folder, totals);
		if (!done) {
			totals.firstCopyDone = false;
		}
	}
	return totals;
}

/** Returns whether the folder reached its delta link (is fully copied). */
async function syncFolder(
	context: SyncContext,
	mailbox: MailboxRow,
	mailboxRoot: string,
	folder: FolderRow,
	totals: SyncOutcome
): Promise<boolean> {
	let resumeLink = folder.deltaLink;
	let firstCopyDone = folder.firstCopyDone;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			for await (const page of folderChanges(
				context.client,
				mailbox.userId,
				folder.graphId,
				resumeLink
			)) {
				await applyChanges(context, mailbox, mailboxRoot, folder, page.changes, totals);
				// The next page's link while a round is under way, the delta link at its end: either
				// way, where the next sync picks up.
				resumeLink = page.deltaLink ?? page.nextLink ?? resumeLink;
				if (page.deltaLink !== null) {
					firstCopyDone = true;
				}
				saveFolderProgress(context.db, folder.id, {
					deltaLink: resumeLink,
					firstCopyDone,
					now: context.now()
				});
				if (context.stopping() && page.nextLink !== null) {
					totals.stoppedEarly = true;
					return false;
				}
			}
			return firstCopyDone;
		} catch (error) {
			// An expired sync state: start the folder's delta again. Messages already stored are
			// recognised by id and skipped, so this costs listing, not downloading.
			if (attempt === 0 && isExpiredSyncState(error)) {
				resumeLink = null;
				firstCopyDone = false;
				continue;
			}
			throw error;
		}
	}
	return firstCopyDone;
}

function isExpiredSyncState(error: unknown): boolean {
	return (
		error instanceof GraphError &&
		(error.status === 410 || /syncstate|resyncrequired/i.test(error.code))
	);
}

async function applyChanges(
	context: SyncContext,
	mailbox: MailboxRow,
	mailboxRoot: string,
	folder: FolderRow,
	changes: readonly MessageChange[],
	totals: SyncOutcome
): Promise<void> {
	await forEachLimited(changes, PER_MAILBOX_CONCURRENCY, async (change) => {
		if (change.kind === 'removed') {
			if (markMessageDeleted(context.db, mailbox.id, folder.id, change.graphId, context.now())) {
				totals.removed += 1;
			}
			return;
		}
		const existing = storedMessage(context.db, mailbox.id, change.graphId);
		if (existing !== undefined) {
			// Already stored: a flag change or a move. The file is the same message either way.
			if (existing.folderId !== folder.id || existing.deletedAt !== null) {
				moveMessage(context.db, existing.id, folder.id);
			}
			return;
		}
		const mime = await messageMime(context.client, mailbox.userId, change.graphId);
		const relative = `${mailboxRoot}/${folder.storagePath}/${messageFileName(change.receivedAt, change.subject, change.graphId)}`;
		const stored = await writeMessageFile(resolveStoragePath(context.backupRoot, relative), mime);
		insertMessage(context.db, {
			mailboxId: mailbox.id,
			folderId: folder.id,
			graphId: change.graphId,
			internetMessageId: change.internetMessageId,
			subject: change.subject,
			sender: change.sender,
			receivedAt: change.receivedAt === null ? null : new Date(change.receivedAt),
			filePath: relative,
			byteCount: stored.byteCount,
			sha256: stored.sha256,
			storedAt: new Date(context.now())
		});
		totals.added += 1;
		totals.byteCount += stored.byteCount;
		context.progress({ folder: folder.path, stored: totals.added, bytes: totals.byteCount });
	});
}

/**
 * Storage paths for Graph's folders. Two folders whose names only differ in characters Windows
 * forbids would map to the same path, so the later one gets a numbered suffix.
 */
export function withUniqueStoragePaths(
	folders: readonly { graphId: string; path: string }[]
): { graphId: string; path: string; storagePath: string }[] {
	const used = new Set<string>();
	return folders.map((folder) => {
		const base = folderStoragePath(folder.path);
		let storagePath = base;
		for (let n = 2; used.has(storagePath.toLowerCase()); n++) {
			storagePath = `${base} ~${n}`;
		}
		used.add(storagePath.toLowerCase());
		return { ...folder, storagePath };
	});
}
