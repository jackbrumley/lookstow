import { asRecord, stringField, type GraphClient } from './client.ts';

/**
 * Reading a primary mailbox through Graph v1.0: its folder tree, each folder's changes since
 * the last sync (delta query), and each message as MIME, which is what goes to disk as .eml.
 */
export type GraphFolder = {
	graphId: string;
	/** Display path from the mailbox root, e.g. `Inbox/Projects`. */
	path: string;
	/** How many items Microsoft says the folder holds, or null when it did not say. */
	totalItemCount: number | null;
};

export type MessageChange =
	| {
			kind: 'upsert';
			graphId: string;
			internetMessageId: string | null;
			subject: string;
			sender: string;
			/** To and Cc addresses, lower case. */
			recipients: string[];
			receivedAt: number | null;
	  }
	| { kind: 'removed'; graphId: string };

/** Every folder, hidden ones included (Recoverable Items stays out: it is not a mail folder). */
export async function listFolders(client: GraphClient, userId: string): Promise<GraphFolder[]> {
	const folders: GraphFolder[] = [];
	const base = `/v1.0/users/${encodeURIComponent(userId)}/mailFolders`;
	const select =
		'$select=id,displayName,childFolderCount,totalItemCount&includeHiddenFolders=true&$top=100';
	const queue: { url: string; parentPath: string }[] = [
		{ url: `${base}?${select}`, parentPath: '' }
	];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			break;
		}
		for await (const page of client.pages(current.url)) {
			for (const item of page.items) {
				const folder = asRecord(item);
				const graphId = stringField(folder, 'id');
				if (graphId === null) {
					continue;
				}
				const name = stringField(folder, 'displayName') ?? graphId;
				const path = current.parentPath === '' ? name : `${current.parentPath}/${name}`;
				const total = folder['totalItemCount'];
				folders.push({ graphId, path, totalItemCount: typeof total === 'number' ? total : null });
				const children = folder['childFolderCount'];
				if (typeof children === 'number' && children > 0) {
					queue.push({
						url: `${base}/${encodeURIComponent(graphId)}/childFolders?${select}`,
						parentPath: path
					});
				}
			}
		}
	}
	return folders;
}

/**
 * One round of a folder's delta query: every change since `deltaLink` (or every message, on the
 * first copy), page by page, then the new delta link. A page's changes are handed over before
 * the next is fetched, so a long first copy saves its progress as it goes.
 */
export async function* folderChanges(
	client: GraphClient,
	userId: string,
	folderGraphId: string,
	deltaLink: string | null
): AsyncGenerator<{ changes: MessageChange[]; deltaLink: string | null; nextLink: string | null }> {
	const start =
		deltaLink ??
		`/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${encodeURIComponent(folderGraphId)}/messages/delta?$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime`;
	for await (const page of client.pages(start)) {
		const changes = page.items.map(toChange).filter((change) => change !== null);
		const delta = stringField(page.reply, '@odata.deltaLink');
		const next = stringField(page.reply, '@odata.nextLink');
		yield { changes, deltaLink: delta, nextLink: next };
	}
}

function toChange(item: unknown): MessageChange | null {
	const message = asRecord(item);
	const graphId = stringField(message, 'id');
	if (graphId === null) {
		return null;
	}
	if ('@removed' in message) {
		return { kind: 'removed', graphId };
	}
	const from = asRecord(asRecord(message['from'])['emailAddress']);
	const received = stringField(message, 'receivedDateTime');
	const receivedAt = received === null ? Number.NaN : Date.parse(received);
	return {
		kind: 'upsert',
		graphId,
		internetMessageId: stringField(message, 'internetMessageId'),
		subject: stringField(message, 'subject') ?? '',
		sender: stringField(from, 'address') ?? stringField(from, 'name') ?? '',
		recipients: [...addresses(message['toRecipients']), ...addresses(message['ccRecipients'])],
		receivedAt: Number.isFinite(receivedAt) ? receivedAt : null
	};
}

function addresses(list: unknown): string[] {
	if (!Array.isArray(list)) {
		return [];
	}
	return list
		.map((entry) => stringField(asRecord(asRecord(entry)['emailAddress']), 'address'))
		.filter((address) => address !== null)
		.map((address) => address.toLowerCase());
}

/** The message exactly as Exchange holds it, attachments included (RFC 822 / MIME). */
export async function messageMime(
	client: GraphClient,
	userId: string,
	messageGraphId: string
): Promise<Buffer> {
	return client.getBytes(
		`/v1.0/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageGraphId)}/$value`
	);
}
