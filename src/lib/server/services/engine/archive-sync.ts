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
import { linkArchiveCopy } from '../mailboxes/archive-links.ts';
import {
	clearItemFailure,
	dueItemFailures,
	recordItemFailure
} from '../mailboxes/item-failures.ts';
import { recheckDue, recordFolderCounts, startRecheck } from '../mailboxes/completeness.ts';
import {
	insertMessage,
	moveMessage,
	saveFolderProgress,
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
	countsFor,
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
	/** Folders listed from the start in this sync: how many items the listing returned. */
	fullListings: Map<string, number>;
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
		pending: [],
		fullListings: new Map()
	};
	const upToDate: FolderRow[] = [];
	await forEachLimited(folders, FOLDERS_AT_ONCE, async (folder) => {
		if (context.stopping()) {
			run.totals.stoppedEarly = true;
			run.totals.firstCopyDone = false;
			return;
		}
		if (await syncArchiveFolder(run, folder, where.get(folder.graphId) ?? mailboxUrl)) {
			upToDate.push(folder);
		} else {
			run.totals.firstCopyDone = false;
		}
	});
	run.totals.removed += applyRemovals(context, mailbox.id, run.pending);
	if (upToDate.length > 0) {
		// Microsoft's counts read after the folders synced (as mail sync does).
		let after: ArchiveFolder[];
		try {
			after = await listArchiveFolders(context.client, mailboxUrl);
		} catch (error) {
			throw explain(error);
		}
		recordFolderCounts(
			context.db,
			mailbox.id,
			countsFor(upToDate, after, run.fullListings),
			context.now()
		);
	}
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
	// Set while the folder is listed from the start: every item the listing returns.
	let seen: Set<string> | null = null;
	if (firstCopyDone && recheckDue(folder, context.now())) {
		// It has differed from Microsoft's count with nothing to explain it: list it all again.
		startRecheck(context.db, folder, run.mailbox.address, context.now());
		resumeLink = null;
		seen = new Set();
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			for await (const page of archiveItemChanges(
				context.client,
				{ graphId: folder.graphId, mailboxUrl: folderMailbox },
				resumeLink
			)) {
				for (const change of page.changes) {
					if (change.kind === 'upsert') seen?.add(change.graphId);
				}
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
			if (seen !== null) run.fullListings.set(folder.id, seen.size);
			return firstCopyDone;
		} catch (error) {
			// An expired sync state (410, or Microsoft's code for it), as mail sync handles it.
			if (attempt === 0 && isExpiredSyncState(error)) {
				resumeLink = null;
				firstCopyDone = false;
				seen = new Set();
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
		} else if (
			existing.folderId !== folder.id ||
			existing.deletedAt !== null ||
			existing.leftAt !== null
		) {
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
			await exportBatch(run, folder, folderMailbox, wanted, batch.ids);
		} finally {
			release();
		}
	});
}

/** A reply Microsoft cut off, or sent empty, again and again (the client already retried). */
function isBrokenExport(error: unknown): boolean {
	return (
		error instanceof GraphError && (error.code === 'broken-reply' || error.code === 'empty-reply')
	);
}

/**
 * Exports one batch and stores what came back. When Microsoft keeps cutting the reply off (a
 * very large reply, or one item it cannot export), the batch is split in half and each half
 * tried on its own, down to single items; an item that still breaks is recorded as one that
 * could not be copied, tried again later, and the rest of the archive carries on. Before, one
 * such batch failed the whole sync, so a first copy started over and never finished.
 */
async function exportBatch(
	run: ArchiveRun,
	folder: FolderRow,
	folderMailbox: string,
	wanted: Map<string, Upsert>,
	ids: readonly string[]
): Promise<void> {
	const { context } = run;
	let exported: Awaited<ReturnType<typeof exportArchiveItems>>;
	try {
		exported = await exportArchiveItems(context.client, folderMailbox, [...ids]);
	} catch (error) {
		if (!isBrokenExport(error)) throw error;
		if (ids.length > 1) {
			const half = Math.ceil(ids.length / 2);
			await exportBatch(run, folder, folderMailbox, wanted, ids.slice(0, half));
			await exportBatch(run, folder, folderMailbox, wanted, ids.slice(half));
			return;
		}
		const change = wanted.get(ids[0] ?? '');
		if (change !== undefined) {
			recordArchiveFailure(
				run,
				folder,
				change,
				`Microsoft's export of this item broke off every time (${error instanceof Error ? error.message : String(error)})`
			);
		}
		return;
	}
	const asked = new Set(ids);
	for (const item of exported) {
		const change = wanted.get(item.graphId);
		// Only what this batch asked for: a split batch's halves must not store an item twice.
		if (change === undefined || !asked.has(item.graphId)) continue;
		if ('error' in item) {
			recordArchiveFailure(run, folder, change, item.error);
		} else {
			await storeItem(run, folder, change, item.data);
		}
	}
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
	const id = insertMessage(context.db, {
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
	// The same email from the person's mailbox, moved here by the archive policy: link the two.
	linkArchiveCopy(context.db, id);
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
