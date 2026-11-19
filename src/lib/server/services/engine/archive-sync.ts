import { indexFts } from '../fts/fts-index.ts';
import { GraphError } from '../graph/client.ts';
import { forEachLimited } from '../graph/discovery.ts';
import { EXPORT_PARALLEL, exportBatches, exportBudget } from './export-batches.ts';
import {
	archiveItemChanges,
	archiveMailboxUrl,
	exportArchiveItems,
	isArchivePermissionError,
	listArchiveFolders,
	type ArchiveFolder,
	type ArchiveItemChange
} from '../graph/archive.ts';
import {
	clearItemFailure,
	dueItemFailures,
	recordItemFailure
} from '../mailboxes/item-failures.ts';
import {
	insertMessage,
	moveMessage,
	saveFolderProgress,
	setFolderSourceCounts,
	storedMessage,
	syncFolderList,
	type FolderRow,
	type MailboxRow
} from '../mailboxes/repository.ts';
import {
	archiveItemFileName,
	mailboxFolderName,
	resolveStoragePath,
	writeMessageFile
} from '../storage/eml-store.ts';
import {
	applyRemovals,
	withUniqueStoragePaths,
	type PendingRemoval,
	type SyncContext,
	type SyncOutcome
} from './sync-common.ts';
import { APP_VERSION } from '../../../utils/app-version.ts';

/**
 * One sync of one online archive: the same shape as a mailbox sync (folder list, then each
 * folder's delta from where it stopped, progress saved after every page), but through the
 * mailbox export API, and each item stored as Exchange's full-fidelity export (`.fts`).
 *
 * Folders run FOLDERS_AT_ONCE at a time and each exports several batches at once (the governor
 * holds each mailbox to what Microsoft allows). An item that cannot be exported is recorded and
 * tried again on later syncs, so it never holds its folder back (docs/specs/SPEC-THROUGHPUT.md
 * 4.9.4).
 */
const FOLDERS_AT_ONCE = 3;

type Upsert = Extract<ArchiveItemChange, { kind: 'upsert' }>;

type ArchiveRun = {
	context: SyncContext;
	mailbox: MailboxRow;
	mailboxRoot: string;
	totals: SyncOutcome;
	pending: PendingRemoval[];
};

export async function syncArchive(context: SyncContext, mailbox: MailboxRow): Promise<SyncOutcome> {
	if (mailbox.exchangeMailboxId === null) {
		throw new Error('Discovery has not found this archive’s mailbox id yet. Run Discover now.');
	}
	const mailboxUrl = archiveMailboxUrl(mailbox.exchangeMailboxId);
	let graphFolders: ArchiveFolder[];
	try {
		graphFolders = await listArchiveFolders(context.client, mailboxUrl);
	} catch (error) {
		throw explain(error);
	}
	const folders = syncFolderList(
		context.db,
		mailbox.id,
		withUniqueStoragePaths(graphFolders),
		context.now()
	);
	const where = new Map(graphFolders.map((folder) => [folder.graphId, folder.mailboxUrl]));
	const run: ArchiveRun = {
		context,
		mailbox,
		mailboxRoot: mailboxFolderName(mailbox.address, mailbox.kind),
		totals: { added: 0, removed: 0, byteCount: 0, firstCopyDone: true, stoppedEarly: false },
		pending: []
	};
	const microsoftCounts = new Map(
		graphFolders.map((folder) => [folder.graphId, folder.totalItemCount])
	);
	const upToDate: { folderId: string; count: number }[] = [];
	await forEachLimited(folders, FOLDERS_AT_ONCE, async (folder) => {
		if (context.stopping()) {
			run.totals.stoppedEarly = true;
			run.totals.firstCopyDone = false;
			return;
		}
		const done = await syncArchiveFolder(run, folder, where.get(folder.graphId) ?? mailboxUrl);
		const count = microsoftCounts.get(folder.graphId) ?? null;
		if (!done) {
			run.totals.firstCopyDone = false;
		} else if (count !== null) {
			upToDate.push({ folderId: folder.id, count });
		}
	});
	run.totals.removed += applyRemovals(context, mailbox.id, run.pending);
	setFolderSourceCounts(context.db, upToDate, context.now());
	return run.totals;
}

async function syncArchiveFolder(
	run: ArchiveRun,
	folder: FolderRow,
	folderMailbox: string
): Promise<boolean> {
	const { context } = run;
	try {
		await retryFailedItems(run, folder, folderMailbox);
	} catch (error) {
		throw explain(error);
	}
	let resumeLink = folder.deltaLink;
	let firstCopyDone = folder.firstCopyDone;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			for await (const page of archiveItemChanges(
				context.client,
				{ graphId: folder.graphId, mailboxUrl: folderMailbox },
				resumeLink
			)) {
				await applyArchiveChanges(run, folder, folderMailbox, page.changes);
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
					run.totals.stoppedEarly = true;
					return false;
				}
			}
			return firstCopyDone;
		} catch (error) {
			// An expired sync state (410, or Microsoft's code for it), as mail sync handles it.
			if (attempt === 0 && isExpiredSyncState(error)) {
				resumeLink = null;
				firstCopyDone = false;
				continue;
			}
			throw explain(error);
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

/** Stores a page of changes; items that cannot be exported are recorded for a later try. */
async function applyArchiveChanges(
	run: ArchiveRun,
	folder: FolderRow,
	folderMailbox: string,
	changes: readonly ArchiveItemChange[]
): Promise<void> {
	const { context, mailbox } = run;
	const wanted = new Map<string, Upsert>();
	for (const change of changes) {
		if (change.kind === 'removed') {
			run.pending.push({ folderId: folder.id, graphId: change.graphId });
			continue;
		}
		const existing = storedMessage(context.db, mailbox.id, change.graphId);
		if (existing === undefined) {
			wanted.set(change.graphId, change);
		} else if (existing.folderId !== folder.id || existing.deletedAt !== null) {
			moveMessage(context.db, existing, folder.id, context.now());
		}
	}
	await exportAndStore(run, folder, folderMailbox, wanted);
}

/**
 * Exports items in batches, several at once (the governor holds the mailbox to what Microsoft
 * allows; the byte budget holds the replies in memory), stores each, and records each item that
 * could not be exported.
 */
async function exportAndStore(
	run: ArchiveRun,
	folder: FolderRow,
	folderMailbox: string,
	wanted: Map<string, Upsert>
): Promise<void> {
	const { context } = run;
	const batches = exportBatches(
		[...wanted.values()].map((change) => ({ id: change.graphId, size: change.size }))
	);
	await forEachLimited(batches, EXPORT_PARALLEL, async (batch) => {
		if (context.stopping()) {
			return;
		}
		const release = await exportBudget.take(batch.bytes);
		try {
			const exported = await exportArchiveItems(context.client, folderMailbox, batch.ids);
			for (const item of exported) {
				const change = wanted.get(item.graphId);
				if (change === undefined) continue;
				if ('error' in item) {
					recordArchiveFailure(run, folder, change, item.error);
				} else {
					await storeItem(run, folder, change, item.data);
				}
			}
		} finally {
			release();
		}
	});
}

async function storeItem(
	run: ArchiveRun,
	folder: FolderRow,
	change: Upsert,
	data: Buffer
): Promise<void> {
	const { context, mailbox, mailboxRoot, totals } = run;
	// The export says only when the item moved into the archive; the item itself says when it
	// was received, so it is filed and found by that. An item the reader cannot read is still
	// stored, under the archive date, and says why in the log.
	const index = indexFts(data, `${mailbox.address} (online archive), ${folder.path}`);
	const when = index?.receivedAt ?? change.createdAt;
	const relative = `${mailboxRoot}/${archiveItemFileName(when, change.type, change.graphId)}`;
	const stored = await writeMessageFile(resolveStoragePath(context.backupRoot, relative), data);
	insertMessage(context.db, {
		mailboxId: mailbox.id,
		folderId: folder.id,
		graphId: change.graphId,
		internetMessageId: index?.internetMessageId ?? null,
		subject: index?.subject ?? '',
		sender: index?.sender ?? '',
		recipients: index?.recipients.join(' ') ?? '',
		receivedAt: when === null ? null : new Date(when),
		filePath: relative,
		byteCount: stored.byteCount,
		sha256: stored.sha256,
		storedAt: new Date(context.now()),
		indexFailedVersion: index === null ? APP_VERSION : null
	});
	clearItemFailure(context.db, mailbox.id, change.graphId);
	totals.added += 1;
	totals.byteCount += stored.byteCount;
	context.progress({ folder: folder.path, stored: totals.added, bytes: totals.byteCount });
}

/** Microsoft's per-item answer when the item is gone from the archive. */
function itemIsGone(error: string): boolean {
	return /^ErrorItemNotFound\b/i.test(error);
}

function recordArchiveFailure(run: ArchiveRun, folder: FolderRow, change: Upsert, error: string) {
	const { context, mailbox } = run;
	if (itemIsGone(error)) {
		clearItemFailure(context.db, mailbox.id, change.graphId);
		return;
	}
	recordItemFailure(
		context.db,
		{
			mailboxId: mailbox.id,
			folderId: folder.id,
			graphId: change.graphId,
			subject: '',
			receivedAt: change.createdAt,
			error: `${folder.path}: ${error}`
		},
		context.now()
	);
}

/**
 * Exports again the folder's failed items whose next try is due. What the delta said about
 * each is not kept, so they are stored as items of class IPM until their export is read.
 */
async function retryFailedItems(
	run: ArchiveRun,
	folder: FolderRow,
	folderMailbox: string
): Promise<void> {
	const { context, mailbox } = run;
	const wanted = new Map<string, Upsert>();
	for (const failure of dueItemFailures(context.db, folder.id, context.now())) {
		if (storedMessage(context.db, mailbox.id, failure.graphId) !== undefined) {
			clearItemFailure(context.db, mailbox.id, failure.graphId);
			continue;
		}
		wanted.set(failure.graphId, {
			kind: 'upsert',
			graphId: failure.graphId,
			type: 'IPM',
			size: null,
			createdAt: failure.receivedAt?.getTime() ?? null
		});
	}
	if (wanted.size > 0) {
		await exportAndStore(run, folder, folderMailbox, wanted);
	}
}

/** Microsoft's refusal, with what to do about it. */
function explain(error: unknown): Error {
	if (isArchivePermissionError(error) && error instanceof GraphError) {
		return new Error(
			`Microsoft refused access to the online archive (${error.status} ${error.code}: ${error.message}). Add the application permissions MailboxFolder.Read.All, MailboxItem.Read.All and MailboxItem.Export.All to the app registration and grant admin consent.`,
			{ cause: error }
		);
	}
	return error instanceof Error ? error : new Error(String(error));
}
