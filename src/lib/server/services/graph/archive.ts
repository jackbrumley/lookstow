import { asRecord, GraphError, stringField, type GraphClient } from './client.ts';

/**
 * Reading an online (In-Place) archive through Microsoft Graph's mailbox import/export API
 * (beta: `/beta/admin/exchange/mailboxes/{id}`). Graph's ordinary mail API cannot see archives.
 *
 * What it gives: the archive's folders, each folder's item changes (delta), and each item as an
 * opaque full-fidelity export stream, the format Exchange itself imports. Items in an auxiliary
 * (auto-expanded) archive live in another mailbox: a folder carries its own `parentMailboxUrl`,
 * folder and item requests there may be redirected (fetch follows the 308), and an export can
 * answer per item with ErrorArchiveFolderMovedPermanently and the URL to export from instead.
 *
 * Permissions (application): MailboxFolder.Read.All, MailboxItem.Read.All,
 * MailboxItem.Export.All.
 */
const BETA_MAILBOXES = 'https://graph.microsoft.com/beta/admin/exchange/mailboxes';
/** exportItems takes at most this many item ids per request, all from one mailbox. */
export const EXPORT_BATCH = 20;

export type ArchiveFolder = {
	graphId: string;
	/** Display path from the archive root, e.g. `Inbox/2019`. */
	path: string;
	/** The mailbox the folder physically lives in: the archive, or an auxiliary archive. */
	mailboxUrl: string;
	totalItemCount: number | null;
	/**
	 * Whether the completeness check compares this folder with Microsoft's count: only mail
	 * folders (folder class IPF.Note, or none given), not Outlook's contact, calendar or metadata
	 * folders such as PersonMetadata, nor folders inside one.
	 */
	compared: boolean;
};

/** A folder class that holds mail: IPF.Note and its kinds (IPF.Note.OutlookHomepage), or none. */
export function isMailFolderClass(type: string | null): boolean {
	return type === null || type === 'IPF.Note' || type.startsWith('IPF.Note.');
}

export type ArchiveItemChange =
	| {
			kind: 'upsert';
			graphId: string;
			/** The message class, e.g. IPM.Note. */
			type: string;
			size: number | null;
			createdAt: number | null;
	  }
	| { kind: 'removed'; graphId: string };

/** The archive mailbox's address in the API: its Exchange mailbox id, as discovery found it. */
export function archiveMailboxUrl(exchangeMailboxId: string): string {
	// Ids look like MBX:e0643f21@a7809c93; Graph's own examples put them in the path as they are.
	if (!/^[A-Za-z0-9:@._=+-]+$/.test(exchangeMailboxId)) {
		throw new Error(`Unexpected archive mailbox id from Microsoft: ${exchangeMailboxId}`);
	}
	return `${BETA_MAILBOXES}/${exchangeMailboxId}`;
}

/** Every folder of the archive, hidden ones included, with paths. */
export async function listArchiveFolders(
	client: GraphClient,
	mailboxUrl: string
): Promise<ArchiveFolder[]> {
	const folders: ArchiveFolder[] = [];
	const query = 'includeHiddenFolders=true&$top=100';
	const queue: {
		url: string;
		parentPath: string;
		parentMailboxUrl: string;
		parentCompared: boolean;
	}[] = [
		{
			url: `${mailboxUrl}/folders?${query}`,
			parentPath: '',
			parentMailboxUrl: mailboxUrl,
			parentCompared: true
		}
	];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			break;
		}
		for await (const page of client.pages(current.url)) {
			for (const item of page.items) {
				const folder = asRecord(item);
				const graphId = stringField(folder, 'id');
				if (graphId === null || seen.has(graphId)) {
					continue;
				}
				seen.add(graphId);
				const name = stringField(folder, 'displayName') ?? graphId;
				const path = current.parentPath === '' ? name : `${current.parentPath}/${name}`;
				const ownMailbox = stringField(folder, 'parentMailboxUrl') ?? current.parentMailboxUrl;
				const total = folder['totalItemCount'];
				const compared = current.parentCompared && isMailFolderClass(stringField(folder, 'type'));
				folders.push({
					graphId,
					path,
					mailboxUrl: ownMailbox,
					totalItemCount: typeof total === 'number' ? total : null,
					compared
				});
				const children = folder['childFolderCount'];
				if (typeof children === 'number' && children > 0) {
					queue.push({
						url: `${ownMailbox}/folders/${encodeURIComponent(graphId)}/childFolders?${query}`,
						parentPath: path,
						parentMailboxUrl: ownMailbox,
						parentCompared: compared
					});
				}
			}
		}
	}
	return folders;
}

/** One round of a folder's item delta, page by page (as `folderChanges` does for mail). */
export async function* archiveItemChanges(
	client: GraphClient,
	folder: Pick<ArchiveFolder, 'graphId' | 'mailboxUrl'>,
	deltaLink: string | null
): AsyncGenerator<{
	changes: ArchiveItemChange[];
	deltaLink: string | null;
	nextLink: string | null;
}> {
	const start =
		deltaLink ??
		`${folder.mailboxUrl}/folders/${encodeURIComponent(folder.graphId)}/items/delta?$select=id,type,size,createdDateTime`;
	for await (const page of client.pages(start)) {
		const changes = page.items.map(toChange).filter((change) => change !== null);
		yield {
			changes,
			deltaLink: stringField(page.reply, '@odata.deltaLink'),
			nextLink: stringField(page.reply, '@odata.nextLink')
		};
	}
}

function toChange(item: unknown): ArchiveItemChange | null {
	const record = asRecord(item);
	const graphId = stringField(record, 'id');
	if (graphId === null) {
		return null;
	}
	if ('@removed' in record) {
		return { kind: 'removed', graphId };
	}
	const created = stringField(record, 'createdDateTime');
	const createdAt = created === null ? Number.NaN : Date.parse(created);
	const size = record['size'];
	return {
		kind: 'upsert',
		graphId,
		type: stringField(record, 'type') ?? 'IPM',
		size: typeof size === 'number' ? size : null,
		createdAt: Number.isFinite(createdAt) ? createdAt : null
	};
}

export type ExportedItem = { graphId: string; data: Buffer } | { graphId: string; error: string };

/**
 * Exports up to EXPORT_BATCH items from one mailbox. An item that has moved to an auxiliary
 * archive is exported again from the URL Graph names; other per-item errors are returned.
 */
export async function exportArchiveItems(
	client: GraphClient,
	mailboxUrl: string,
	itemIds: readonly string[]
): Promise<ExportedItem[]> {
	if (itemIds.length === 0) {
		return [];
	}
	if (itemIds.length > EXPORT_BATCH) {
		throw new Error(`exportItems takes at most ${EXPORT_BATCH} items at a time`);
	}
	const reply = asRecord(await client.postJson(`${mailboxUrl}/exportItems`, { itemIds }));
	const results = Array.isArray(reply['value']) ? reply['value'].map(asRecord) : [];
	const exported: ExportedItem[] = [];
	const moved = new Map<string, string[]>();
	const asked = new Set(itemIds);
	for (const result of results) {
		const graphId = stringField(result, 'itemId') ?? stringField(result, 'id');
		// Only the items asked for: a split batch must never export another half's item.
		if (graphId === null || !asked.has(graphId)) {
			continue;
		}
		const data = stringField(result, 'data');
		const error = asRecord(result['error']);
		const code = stringField(error, 'code');
		if (data !== null && code === null) {
			exported.push({ graphId, data: Buffer.from(data, 'base64') });
			continue;
		}
		const message = stringField(error, 'message') ?? 'no reason given';
		const target = code === 'ErrorArchiveFolderMovedPermanently' ? movedTo(message) : null;
		if (target !== null && target !== mailboxUrl) {
			moved.set(target, [...(moved.get(target) ?? []), graphId]);
		} else {
			exported.push({ graphId, error: `${code ?? 'error'}: ${message}` });
		}
	}
	for (const [target, ids] of moved) {
		exported.push(...(await exportArchiveItems(client, target, ids)));
	}
	const answered = new Set(exported.map((item) => item.graphId));
	for (const id of itemIds) {
		if (!answered.has(id)) {
			exported.push({ graphId: id, error: 'Microsoft Graph did not return this item' });
		}
	}
	return exported;
}

/** The mailbox URL in an ErrorArchiveFolderMovedPermanently message, ending before /exportItems. */
function movedTo(message: string): string | null {
	const match = /https:\/\/graph\.microsoft\.com\/[^\s"']+/.exec(message);
	if (match === null) {
		return null;
	}
	return match[0].replace(/\/exportItems\/?$/i, '').replace(/[.,)]+$/, '');
}

/** Whether an error means the app lacks the archive permissions. */
export function isArchivePermissionError(error: unknown): boolean {
	return error instanceof GraphError && (error.status === 401 || error.status === 403);
}
