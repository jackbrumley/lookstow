import { indexFts } from '../fts/fts-index.ts';
import { GraphError } from '../graph/client.ts';
import {
	archiveItemChanges,
	archiveMailboxUrl,
	EXPORT_BATCH,
	exportArchiveItems,
	isArchivePermissionError,
	listArchiveFolders,
	type ArchiveFolder,
	type ArchiveItemChange
} from '../graph/archive.ts';
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
 * A page whose items could not all be exported keeps its place, so the next sync asks for
 * those items again; the sync reports them as a failure with Microsoft's reason.
 */
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
	const mailboxRoot = mailboxFolderName(mailbox.address, mailbox.kind);
	const totals: SyncOutcome = {
		added: 0,
		removed: 0,
		byteCount: 0,
		firstCopyDone: true,
		stoppedEarly: false
	};
	const failures: string[] = [];
	const pending: PendingRemoval[] = [];
	for (const folder of folders) {
		if (context.stopping()) {
			totals.stoppedEarly = true;
			totals.firstCopyDone = false;
			break;
		}
		const folderMailbox = where.get(folder.graphId) ?? mailboxUrl;
		const done = await syncArchiveFolder(
			context,
			mailbox,
			mailboxRoot,
			folder,
			folderMailbox,
			totals,
			failures,
			pending
		);
		if (!done) {
			totals.firstCopyDone = false;
		}
	}
	totals.removed += applyRemovals(context, mailbox.id, pending);
	if (failures.length > 0) {
		throw new Error(
			`${failures.length} archive item${failures.length === 1 ? '' : 's'} could not be exported and will be tried again: ${failures.slice(0, 3).join('; ')}`
		);
	}
	return totals;
}

async function syncArchiveFolder(
	context: SyncContext,
	mailbox: MailboxRow,
	mailboxRoot: string,
	folder: FolderRow,
	folderMailbox: string,
	totals: SyncOutcome,
	failures: string[],
	pending: PendingRemoval[]
): Promise<boolean> {
	let resumeLink = folder.deltaLink;
	let firstCopyDone = folder.firstCopyDone;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			for await (const page of archiveItemChanges(
				context.client,
				{ graphId: folder.graphId, mailboxUrl: folderMailbox },
				resumeLink
			)) {
				const pageFailures = await applyArchiveChanges(
					context,
					mailbox,
					mailboxRoot,
					folder,
					folderMailbox,
					page.changes,
					totals,
					pending
				);
				if (pageFailures.length > 0) {
					// Keep the place before this page: the next sync exports what failed.
					failures.push(...pageFailures);
					return false;
				}
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
			if (attempt === 0 && error instanceof GraphError && error.status === 410) {
				resumeLink = null;
				firstCopyDone = false;
				continue;
			}
			throw explain(error);
		}
	}
	return firstCopyDone;
}

/** Stores a page of changes; returns the items that could not be exported. */
async function applyArchiveChanges(
	context: SyncContext,
	mailbox: MailboxRow,
	mailboxRoot: string,
	folder: FolderRow,
	folderMailbox: string,
	changes: readonly ArchiveItemChange[],
	totals: SyncOutcome,
	pending: PendingRemoval[]
): Promise<string[]> {
	const wanted = new Map<string, Extract<ArchiveItemChange, { kind: 'upsert' }>>();
	for (const change of changes) {
		if (change.kind === 'removed') {
			pending.push({ folderId: folder.id, graphId: change.graphId });
			continue;
		}
		const existing = storedMessage(context.db, mailbox.id, change.graphId);
		if (existing === undefined) {
			wanted.set(change.graphId, change);
		} else if (existing.folderId !== folder.id || existing.deletedAt !== null) {
			moveMessage(context.db, existing, folder.id, context.now());
		}
	}
	const ids = [...wanted.keys()];
	const failures: string[] = [];
	for (let start = 0; start < ids.length; start += EXPORT_BATCH) {
		if (context.stopping()) {
			break;
		}
		const exported = await exportArchiveItems(
			context.client,
			folderMailbox,
			ids.slice(start, start + EXPORT_BATCH)
		);
		for (const item of exported) {
			const change = wanted.get(item.graphId);
			if (change === undefined) {
				continue;
			}
			if ('error' in item) {
				failures.push(`${folder.path}: ${item.error}`);
				continue;
			}
			// The export says only when the item moved into the archive; the item itself says when it
			// was received, so it is filed and found by that. An item the reader cannot read is
			// still stored, under the archive date, and says why in the log.
			const index = indexFts(item.data, `${mailbox.address} (online archive), ${folder.path}`);
			const when = index?.receivedAt ?? change.createdAt;
			const relative = `${mailboxRoot}/${archiveItemFileName(when, change.type, change.graphId)}`;
			const stored = await writeMessageFile(
				resolveStoragePath(context.backupRoot, relative),
				item.data
			);
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
			totals.added += 1;
			totals.byteCount += stored.byteCount;
			context.progress({ folder: folder.path, stored: totals.added, bytes: totals.byteCount });
		}
	}
	return failures;
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
