import { syncArchive } from './archive-sync.ts';
import { errorText, serverLog } from '../../log.ts';
import { readScope } from '../settings/settings.ts';
import {
	applyRemovals,
	countsFor,
	withUniqueStoragePaths,
	type PendingRemoval,
	type SyncContext,
	type SyncOutcome
} from './sync-common.ts';
import { GraphError } from '../graph/client.ts';
import { forEachLimited } from '../graph/discovery.ts';
import {
	folderChanges,
	isGone,
	listFolders,
	listOptionalFolders,
	messageNow,
	type GraphFolder,
	streamMessageMime,
	type MessageChange
} from '../graph/mail.ts';
import {
	clearItemFailure,
	dueItemFailures,
	recordItemFailure
} from '../mailboxes/item-failures.ts';
import { recheckDue, recordFolderCounts, startRecheck } from '../mailboxes/completeness.ts';
import {
	insertMessage,
	liveMessageIds,
	moveMessage,
	saveFolderProgress,
	storedMessage,
	syncFolderList,
	type FolderRow,
	type MailboxRow
} from '../mailboxes/repository.ts';
import {
	mailboxFolderName,
	messageFileName,
	resolveStoragePath,
	writeMessageStream
} from '../storage/eml-store.ts';

/**
 * One sync of one primary mailbox: refresh the folder list, then run each folder's delta query
 * from where the last sync stopped, storing every new message as .eml and recording messages
 * the source deleted (their files stay). Progress is saved after every page, so a stop or crash
 * in the middle of a 50 GB first copy loses at most one page.
 *
 * Fast without losing that guarantee (docs/specs/SPEC-THROUGHPUT.md 4.3): folders run
 * FOLDERS_AT_ONCE at a time and a folder's next page is fetched while its current page
 * downloads, so the mailbox's requests (the governor holds them to what Microsoft allows) never
 * sit idle at a page or folder edge; messages stream straight to disk. One message that cannot
 * be copied is recorded and tried again later instead of stopping its folder (4.9.4).
 */
const FOLDERS_AT_ONCE = 3;
/** Downloads a page starts at once; the governor's lane is the real limit (4 at first). */
const DOWNLOADS_AT_ONCE = 8;

type Upsert = Extract<MessageChange, { kind: 'upsert' }>;

type MailboxRun = {
	context: SyncContext;
	mailbox: MailboxRow;
	mailboxRoot: string;
	foldersByGraphId: Map<string, FolderRow>;
	totals: SyncOutcome;
	pending: PendingRemoval[];
	/** Folders listed from the start in this sync: how many messages the listing returned. */
	fullListings: Map<string, number>;
};

export async function syncMailbox(context: SyncContext, mailbox: MailboxRow): Promise<SyncOutcome> {
	if (mailbox.kind === 'archive') {
		return syncArchive(context, mailbox);
	}
	const graphFolders: GraphFolder[] = await listFolders(context.client, mailbox.userId);
	if (readScope(context.db).includeRecoverable) {
		const optional = await listOptionalFolders(context.client, mailbox.userId);
		graphFolders.push(...optional.folders);
		reportRefusals(mailbox, optional.refused);
	}
	const folders = syncFolderList(
		context.db,
		mailbox.id,
		withUniqueStoragePaths(graphFolders),
		context.now()
	);
	const run: MailboxRun = {
		context,
		mailbox,
		mailboxRoot: mailboxFolderName(mailbox.address, mailbox.kind),
		foldersByGraphId: new Map(folders.map((folder) => [folder.graphId, folder])),
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
		if (folder.optional) {
			// Recoverable Items or the root: a refusal is logged, never fails the sync, and its
			// copy never holds up the mailbox's first copy.
			try {
				if (await syncFolder(run, folder)) upToDate.push(folder);
			} catch (error) {
				reportOptionalFailure(mailbox, folder, error);
			}
			return;
		}
		if (await syncFolder(run, folder)) {
			upToDate.push(folder);
		} else {
			run.totals.firstCopyDone = false;
		}
	});
	run.totals.removed += applyRemovals(context, mailbox.id, run.pending);
	if (upToDate.length > 0) {
		// Microsoft's counts read after the folders synced, so mail that arrived or went during
		// the sync does not show as a difference.
		const after = await listFolders(context.client, mailbox.userId);
		recordFolderCounts(
			context.db,
			mailbox.id,
			countsFor(upToDate, after, run.fullListings),
			context.now()
		);
	}
	return run.totals;
}

/** Returns whether the folder reached its delta link (is fully copied). */
async function syncFolder(run: MailboxRun, folder: FolderRow): Promise<boolean> {
	const { context, mailbox } = run;
	await retryFailedMessages(run, folder);
	let resumeLink = folder.deltaLink;
	let firstCopyDone = folder.firstCopyDone;
	// Set while a delta restarted from the beginning: every message the fresh pass lists.
	const restart: { seen: Set<string> | null } = { seen: null };
	if (firstCopyDone && recheckDue(folder, context.now())) {
		// It has differed from Microsoft's count with nothing to explain it: list it all again.
		startRecheck(context.db, folder, mailbox.address, context.now());
		resumeLink = null;
		restart.seen = new Set();
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			for await (const page of prefetched(
				folderChanges(context.client, mailbox.userId, folder.graphId, resumeLink)
			)) {
				for (const change of page.changes) {
					if (change.kind === 'upsert') restart.seen?.add(change.graphId);
				}
				await applyChanges(run, folder, page.changes);
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
					run.totals.stoppedEarly = true;
					return false;
				}
			}
			if (restart.seen !== null) {
				await checkUnseen(run, folder, restart.seen);
				run.fullListings.set(folder.id, restart.seen.size);
			}
			return firstCopyDone;
		} catch (error) {
			// An expired sync state: start the folder's delta again. Messages already stored are
			// recognised by id and skipped, so this costs listing, not downloading. Messages
			// deleted meanwhile get no "removed" from a fresh start: they are checked at its end.
			if (attempt === 0 && isExpiredSyncState(error)) {
				resumeLink = null;
				firstCopyDone = false;
				restart.seen = new Set();
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

/**
 * Asks for the next item while the caller works on the current one: a folder's next delta page
 * is on its way while this page's messages download.
 */
async function* prefetched<T>(source: AsyncGenerator<T>): AsyncGenerator<T> {
	let next = source.next();
	try {
		for (;;) {
			const current = await next;
			if (current.done === true) return;
			next = source.next();
			yield current.value;
		}
	} finally {
		// Stopped early: the page asked for in advance is not wanted, nor its error.
		next.catch(() => undefined);
	}
}

async function applyChanges(
	run: MailboxRun,
	folder: FolderRow,
	changes: readonly MessageChange[]
): Promise<void> {
	const { context, mailbox } = run;
	await forEachLimited(changes, DOWNLOADS_AT_ONCE, async (change) => {
		if (change.kind === 'removed') {
			run.pending.push({ folderId: folder.id, graphId: change.graphId });
			return;
		}
		const existing = storedMessage(context.db, mailbox.id, change.graphId);
		if (existing !== undefined) {
			// Already stored: a flag change or a move. The file is the same message either way.
			if (
				existing.folderId !== folder.id ||
				existing.deletedAt !== null ||
				existing.leftAt !== null
			) {
				moveMessage(context.db, existing, folder.id, context.now());
			}
			return;
		}
		await storeOrRecord(run, folder, change);
	});
}

/**
 * Stores one message; one that cannot be copied is recorded for a later try instead of
 * stopping its folder. A message gone from Microsoft 365 since the delta listed it is skipped.
 * Problems with the whole mailbox (refused, unreachable) still end the sync.
 */
async function storeOrRecord(run: MailboxRun, folder: FolderRow, change: Upsert): Promise<void> {
	const { context, mailbox } = run;
	try {
		await storeMessage(run, folder, change);
	} catch (error) {
		if (isGone(error)) {
			clearItemFailure(context.db, mailbox.id, change.graphId);
			return;
		}
		if (!isItemProblem(error)) throw error;
		recordItemFailure(
			context.db,
			{
				mailboxId: mailbox.id,
				folderId: folder.id,
				graphId: change.graphId,
				subject: change.subject,
				receivedAt: change.receivedAt,
				error: error instanceof Error ? error.message : String(error)
			},
			context.now()
		);
	}
}

async function storeMessage(run: MailboxRun, folder: FolderRow, change: Upsert): Promise<void> {
	const { context, mailbox, mailboxRoot, totals } = run;
	const relative = `${mailboxRoot}/${messageFileName(change.receivedAt, change.subject, change.graphId)}`;
	const stored = await streamMessageMime(context.client, mailbox.userId, change.graphId, (body) =>
		writeMessageStream(resolveStoragePath(context.backupRoot, relative), body)
	);
	insertMessage(context.db, {
		mailboxId: mailbox.id,
		folderId: folder.id,
		graphId: change.graphId,
		internetMessageId: change.internetMessageId,
		subject: change.subject,
		sender: change.sender,
		recipients: change.recipients.join(' '),
		receivedAt: change.receivedAt === null ? null : new Date(change.receivedAt),
		filePath: relative,
		byteCount: stored.byteCount,
		sha256: stored.sha256,
		storedAt: new Date(context.now())
	});
	clearItemFailure(context.db, mailbox.id, change.graphId);
	totals.added += 1;
	totals.byteCount += stored.byteCount;
	context.progress({ folder: folder.path, stored: totals.added, bytes: totals.byteCount });
}

/**
 * A problem with one message, not the mailbox: Microsoft refused this item (4xx other than
 * sign-in, permission and throttling), or its reply kept breaking. Anything else (refused
 * access, Microsoft or the network down after every retry) concerns the whole mailbox.
 */
function isItemProblem(error: unknown): boolean {
	if (!(error instanceof GraphError)) return false;
	if (error.code === 'broken-reply' || error.code === 'empty-reply') return true;
	return error.status >= 400 && error.status < 500 && ![401, 403, 429].includes(error.status);
}

/** Tries again the folder's failed messages whose next try is due. */
async function retryFailedMessages(run: MailboxRun, folder: FolderRow): Promise<void> {
	const { context, mailbox } = run;
	const due = dueItemFailures(context.db, folder.id, context.now());
	await forEachLimited(due, DOWNLOADS_AT_ONCE, async (failure) => {
		if (context.stopping()) return;
		if (storedMessage(context.db, mailbox.id, failure.graphId) !== undefined) {
			clearItemFailure(context.db, mailbox.id, failure.graphId);
			return;
		}
		let found: Awaited<ReturnType<typeof messageNow>>;
		try {
			found = await messageNow(context.client, mailbox.userId, failure.graphId);
		} catch (error) {
			if (!isItemProblem(error)) throw error;
			recordItemFailure(
				context.db,
				{
					mailboxId: mailbox.id,
					folderId: folder.id,
					graphId: failure.graphId,
					subject: failure.subject,
					receivedAt: failure.receivedAt?.getTime() ?? null,
					error: error instanceof Error ? error.message : String(error)
				},
				context.now()
			);
			return;
		}
		if (found === null) {
			// Gone from Microsoft 365 since it failed: nothing left to copy.
			clearItemFailure(context.db, mailbox.id, failure.graphId);
			return;
		}
		const current =
			(found.folderGraphId === null ? undefined : run.foldersByGraphId.get(found.folderGraphId)) ??
			folder;
		await storeOrRecord(run, current, found.change);
	});
}

/**
 * After a delta restarted from the beginning: a stored message the fresh pass did not list was
 * deleted meanwhile, or moved. Each is checked; only one Microsoft 365 no longer has is recorded
 * as deleted (a moved one is listed by its new folder's delta).
 */
async function checkUnseen(run: MailboxRun, folder: FolderRow, seen: Set<string>): Promise<void> {
	const { context, mailbox } = run;
	const unseen = liveMessageIds(context.db, folder.id).filter((graphId) => !seen.has(graphId));
	await forEachLimited(unseen, DOWNLOADS_AT_ONCE, async (graphId) => {
		if (context.stopping()) return;
		const now = await messageNow(context.client, mailbox.userId, graphId);
		// Gone, or now in a folder Lookstow does not copy (Shift+Delete puts it in the hidden
		// Recoverable Items, where Microsoft still finds it by id): deleted at the source. In
		// another folder Lookstow copies, that folder's sync records the move.
		if (
			now === null ||
			(now.folderGraphId !== null &&
				now.folderGraphId !== folder.graphId &&
				!run.foldersByGraphId.has(now.folderGraphId))
		) {
			run.pending.push({ folderId: folder.id, graphId });
		}
	});
}

/** Each mailbox's refused opt-in folders, logged once while the service runs. */
const refusalsLogged = new Set<string>();

function reportRefusals(mailbox: MailboxRow, refused: readonly string[]): void {
	if (refused.length === 0 || refusalsLogged.has(mailbox.id)) return;
	refusalsLogged.add(mailbox.id);
	serverLog(
		'warn',
		'recoverable',
		`${mailbox.address}: Microsoft did not allow copying ${refused.join(' and ')}. The rest of the mailbox syncs as usual.`
	);
}

function reportOptionalFailure(mailbox: MailboxRow, folder: FolderRow, error: unknown): void {
	if (refusalsLogged.has(folder.id)) return;
	refusalsLogged.add(folder.id);
	serverLog(
		'warn',
		'recoverable',
		`${mailbox.address}: ${folder.path} could not be copied (${errorText(error)}). The rest of the mailbox syncs as usual.`
	);
}
