import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	FakeGraph,
	TEST_CREDENTIALS,
	graphError,
	json,
	noSleep
} from '#tests/support/fake-graph.ts';
import { ftsFile, int, recipient, str, time } from '#tests/support/fts-builder.ts';
import { openDatabase } from '../../database/connection.ts';
import { PROP } from '../fts/fts-properties.ts';
import { eq } from 'drizzle-orm';
import { mailboxes, mailFolders, messages } from '../../database/schema.ts';
import { GraphClient } from '../graph/client.ts';
import { unpacedGovernor } from '../graph/governor.ts';
import { TokenSource } from '../graph/token.ts';
import { indexArchiveItems } from '../fts/fts-index.ts';
import { mailboxItemFailures } from '../mailboxes/item-failures.ts';
import {
	applyDiscovery,
	foldersOf,
	insertMessage,
	syncFolderList
} from '../mailboxes/repository.ts';
import { resolveStoragePath, writeMessageFile } from '../storage/eml-store.ts';
import { syncMailbox } from './mailbox-sync.ts';
import type { SyncContext } from './sync-common.ts';

const BETA = 'https://graph.microsoft.com/beta/admin/exchange/mailboxes';
const MAIN = `${BETA}/MBX:arc@t`;
const AUX = `${BETA}/MBX:aux@t`;

function item(id: string, created: string) {
	return { id, type: 'IPM.Note', size: 10, createdDateTime: created };
}

/** When each invented item was received: years before it moved into the archive. */
const RECEIVED: Record<string, number> = {
	i1: Date.parse('2018-01-02T03:04:05Z'),
	i2: Date.parse('2018-01-03T00:00:00Z'),
	i3: Date.parse('2017-05-06T00:00:00Z')
};

/** An invented archive item as the export API gives it: a real-format .fts file. */
function ftsOf(id: string): Buffer {
	return ftsFile(
		Buffer.concat([
			str(PROP.messageClass, 'IPM.Note'),
			str(PROP.subject, `Subject ${id}`),
			str(PROP.senderSmtpAddress, `${id}@example.com`),
			time(PROP.messageDeliveryTime, RECEIVED[id] ?? 0),
			recipient(int(PROP.recipientType, 1), str(PROP.smtpAddress, 'Ann@Example.com'))
		])
	);
}

function exported(id: string) {
	return { itemId: id, data: ftsOf(id).toString('base64') };
}

/** An archive with Inbox, and Inbox/2019 in an auxiliary archive. */
function archive(): FakeGraph {
	return new FakeGraph()
		.withToken()
		.on(/^\/beta\/admin\/exchange\/mailboxes\/MBX:arc@t\/folders\?/, () =>
			json({
				value: [
					{
						id: 'inbox',
						displayName: 'Inbox',
						childFolderCount: 1,
						totalItemCount: 2,
						parentMailboxUrl: MAIN
					}
				]
			})
		)
		.on(/MBX:arc@t\/folders\/inbox\/childFolders/, () =>
			json({
				value: [{ id: 'y2019', displayName: '2019', childFolderCount: 0, parentMailboxUrl: AUX }]
			})
		)
		.on(/MBX:arc@t\/folders\/inbox\/items\/delta/, () =>
			json({
				value: [item('i1', '2020-02-03T04:05:06Z'), item('i2', '2020-02-04T00:00:00Z')],
				'@odata.deltaLink': `${MAIN}/folders/inbox/items/delta?$deltatoken=a`
			})
		)
		.on(/MBX:aux@t\/folders\/y2019\/items\/delta/, () =>
			json({
				value: [item('i3', '2019-05-06T00:00:00Z')],
				'@odata.deltaLink': `${AUX}/folders/y2019/items/delta?$deltatoken=b`
			})
		)
		.on(/MBX:arc@t\/exportItems$/, () =>
			json({
				value: [
					exported('i1'),
					{
						itemId: 'i2',
						error: {
							code: 'ErrorArchiveFolderMovedPermanently',
							message: `The folder moved. Use ${AUX}/exportItems`
						}
					}
				]
			})
		)
		.on(/MBX:aux@t\/exportItems$/, () => json({ value: [exported('i2'), exported('i3')] }));
}

async function setup(graph: FakeGraph) {
	const db = openDatabase(':memory:');
	const { added } = applyDiscovery(
		db,
		[
			{
				userId: 'u',
				kind: 'user',
				address: 'ann@example.com',
				displayName: 'Ann',
				exchangeMailboxId: null
			},
			{
				userId: 'u',
				kind: 'archive',
				address: 'ann@example.com',
				displayName: 'Ann (archive)',
				exchangeMailboxId: 'MBX:arc@t'
			}
		],
		1
	);
	const row = added.find((mailbox) => mailbox.kind === 'archive');
	if (row === undefined) throw new Error('no archive');
	const backupRoot = await mkdtemp(join(tmpdir(), 'lookstow-archive-'));
	const context: SyncContext = {
		db,
		client: new GraphClient(new TokenSource(TEST_CREDENTIALS, graph.fetch), {
			governor: unpacedGovernor(),
			fetch: graph.fetch,
			sleep: noSleep
		}),
		backupRoot,
		now: () => 1000,
		stopping: () => false,
		progress: () => undefined
	};
	return { db, row, backupRoot, context };
}

describe('copying an online archive', () => {
	it('exports every item, follows items moved to an auxiliary archive, and files them by date', async () => {
		const graph = archive();
		const { db, row, backupRoot, context } = await setup(graph);
		const outcome = await syncMailbox(context, row);
		expect(outcome).toMatchObject({ added: 3, firstCopyDone: true });
		const stored = db.select().from(messages).all();
		expect(stored.map((message) => message.graphId).sort()).toEqual(['i1', 'i2', 'i3']);
		const first = stored.find((message) => message.graphId === 'i1');
		// Filed by when it was received (read from the item), not when it moved into the archive.
		expect(first?.filePath).toMatch(
			/^ann@example.com \(archive\)\/2018\/01\/2018-01-02_030405_IPM.Note_[0-9a-f]{10}\.fts$/
		);
		expect(first).toMatchObject({
			subject: 'Subject i1',
			sender: 'i1@example.com',
			recipients: 'ann@example.com',
			receivedAt: new Date(RECEIVED['i1'] ?? 0)
		});
		// The file is the export exactly as Microsoft gave it.
		expect(await readFile(join(backupRoot, ...(first?.filePath ?? '').split('/')))).toEqual(
			ftsOf('i1')
		);
		expect(
			foldersOf(db, row.id)
				.map((folder) => folder.path)
				.sort()
		).toEqual(['Inbox', 'Inbox/2019']);
		// Microsoft's count is recorded for the completeness check.
		expect(foldersOf(db, row.id).find((folder) => folder.graphId === 'inbox')?.sourceCount).toBe(2);
	});

	it('says which permissions to add when Microsoft refuses', async () => {
		const graph = new FakeGraph()
			.withToken()
			.on(/MBX:arc@t\/folders/, () => graphError(403, 'ErrorAccessDenied', 'Access is denied.'));
		const { row, context } = await setup(graph);
		await expect(syncMailbox(context, row)).rejects.toThrow(/MailboxItem\.Export\.All/);
	});

	it('records items that could not be exported, moves on, and exports them later', async () => {
		let refusing = true;
		const graph = archive().on(/MBX:aux@t\/exportItems$/, () =>
			refusing
				? json({
						value: [
							{ itemId: 'i2', error: { code: 'ErrorItemCorrupt', message: 'Corrupt' } },
							{ itemId: 'i3', error: { code: 'ErrorItemCorrupt', message: 'Corrupt' } }
						]
					})
				: json({ value: [exported('i2'), exported('i3')] })
		);
		const { db, row, context } = await setup(graph);
		await expect(syncMailbox(context, row)).resolves.toMatchObject({ added: 1 });
		// The folders moved on past the items that failed.
		const inbox = foldersOf(db, row.id).find((folder) => folder.graphId === 'inbox');
		expect(inbox?.deltaLink).not.toBeNull();
		expect(
			mailboxItemFailures(db, row.id)
				.map((failure) => failure.graphId)
				.sort()
		).toEqual(['i2', 'i3']);
		// Microsoft exports them now; once due, the next sync stores them.
		refusing = false;
		await syncMailbox({ ...context, now: () => 1000 + 16 * 60_000 }, row);
		expect(
			db
				.select()
				.from(messages)
				.all()
				.map((message) => message.graphId)
				.sort()
		).toEqual(['i1', 'i2', 'i3']);
		expect(mailboxItemFailures(db, row.id)).toEqual([]);
	});

	it('splits a batch whose reply keeps breaking off, and records an item that still breaks', async () => {
		// Seen on a real archive: Microsoft cut the export reply off every time. The sync must
		// carry on with everything else, not fail and start the first copy over.
		const cutOff = () =>
			new Response('{"value": [{"itemId": "i2", "data": "AAAA', {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		// The auxiliary archive (i2 moved there, and i3) always cuts its reply off.
		const graph = archive().on(/MBX:aux@t\/exportItems$/, cutOff);
		const { db, row, context } = await setup(graph);
		await expect(syncMailbox(context, row)).resolves.toMatchObject({ added: 1 });
		expect(
			mailboxItemFailures(db, row.id)
				.map((failure) => failure.graphId)
				.sort()
		).toEqual(['i2', 'i3']);
	});
});

describe('archive items stored before Lookstow could read them', () => {
	it('are read once for Search; their files are not changed', async () => {
		const { db, row, backupRoot } = await setup(new FakeGraph());
		const [folder] = syncFolderList(
			db,
			row.id,
			[{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' }],
			1
		);
		if (folder === undefined) throw new Error('no folder');
		const store = async (graphId: string, data: Buffer) => {
			const relative = `ann@example.com (archive)/2020/02/${graphId}.fts`;
			await writeMessageFile(resolveStoragePath(backupRoot, relative), data);
			insertMessage(db, {
				mailboxId: row.id,
				folderId: folder.id,
				graphId,
				internetMessageId: null,
				subject: '',
				sender: '',
				recipients: '',
				receivedAt: new Date(Date.parse('2020-02-03T00:00:00Z')),
				filePath: relative,
				byteCount: data.length,
				sha256: 'x',
				storedAt: new Date(1)
			});
		};
		await store('i1', ftsOf('i1'));
		await store('bad', Buffer.from('not an fts file'));
		const outcome = await indexArchiveItems(db, backupRoot, () => false, '0.7.0');
		expect(outcome).toEqual({ total: 2, indexed: 1, problems: 1, stopped: false });
		const rows = db.select().from(messages).all();
		expect(rows.find((message) => message.graphId === 'i1')).toMatchObject({
			subject: 'Subject i1',
			sender: 'i1@example.com',
			receivedAt: new Date(RECEIVED['i1'] ?? 0),
			filePath: 'ann@example.com (archive)/2020/02/i1.fts'
		});
		expect(rows.find((message) => message.graphId === 'bad')?.subject).toBe('');
		// Read once: the same version does not try the unreadable item again, a newer one does.
		expect((await indexArchiveItems(db, backupRoot, () => false, '0.7.0')).total).toBe(0);
		expect(
			db
				.select()
				.from(messages)
				.all()
				.find((message) => message.graphId === 'bad')?.indexFailedVersion
		).toBe('0.7.0');
		expect((await indexArchiveItems(db, backupRoot, () => false, '0.7.1')).total).toBe(1);
	});
});

/** One folder, Inbox, whose count Microsoft gives as `count`, listing `ids` in one page. */
function oneFolderArchive(count: number, ids: string[]): FakeGraph {
	return new FakeGraph()
		.withToken()
		.on(/^\/beta\/admin\/exchange\/mailboxes\/MBX:arc@t\/folders\?/, () =>
			json({
				value: [
					{
						id: 'inbox',
						displayName: 'Inbox',
						childFolderCount: 0,
						totalItemCount: count,
						parentMailboxUrl: MAIN
					}
				]
			})
		)
		.on(/MBX:arc@t\/folders\/inbox\/items\/delta/, () =>
			json({
				value: ids.map((id) => item(id, '2020-02-03T04:05:06Z')),
				'@odata.deltaLink': `${MAIN}/folders/inbox/items/delta?$deltatoken=a`
			})
		)
		.on(/MBX:arc@t\/exportItems$/, () => json({ value: ids.map(exported) }));
}

function contextFor(db: SyncContext['db'], backupRoot: string, graph: FakeGraph): SyncContext {
	return {
		db,
		client: new GraphClient(new TokenSource(TEST_CREDENTIALS, graph.fetch), {
			governor: unpacedGovernor(),
			fetch: graph.fetch,
			sleep: noSleep
		}),
		backupRoot,
		now: () => 1000,
		stopping: () => false,
		progress: () => undefined
	};
}

/** Makes the folder's next sync list it from the start (as the weekly listing check does). */
function listAgainNext(db: SyncContext['db'], mailboxId: string): void {
	const inbox = foldersOf(db, mailboxId).find((folder) => folder.graphId === 'inbox');
	if (inbox === undefined) throw new Error('no inbox');
	db.update(mailFolders)
		.set({ countFromListing: true, listedAt: null })
		.where(eq(mailFolders.id, inbox.id))
		.run();
}

describe('an auto-expanding archive', () => {
	it('records how many parts its folders are listed in', async () => {
		const { db, row, context } = await setup(archive());
		await syncMailbox(context, row);
		expect(db.select().from(mailboxes).where(eq(mailboxes.id, row.id)).get()?.archiveParts).toBe(2);
	});

	it('checks a folder Microsoft counts as empty against its full listing instead', async () => {
		const { db, row, backupRoot } = await setup(archive());
		await syncMailbox(contextFor(db, backupRoot, oneFolderArchive(0, ['i1', 'i2'])), row);
		listAgainNext(db, row.id);
		await syncMailbox(contextFor(db, backupRoot, oneFolderArchive(0, ['i1', 'i2'])), row);
		const inbox = foldersOf(db, row.id).find((folder) => folder.graphId === 'inbox');
		expect(inbox).toMatchObject({ countFromListing: true, listedCount: 2, differsSince: null });
		expect(inbox?.sourceCount).toBe(0);
	});

	it('records items a full listing no longer returns as deleted at the source, keeping them', async () => {
		const { db, row, backupRoot } = await setup(archive());
		await syncMailbox(contextFor(db, backupRoot, oneFolderArchive(2, ['i1', 'i2'])), row);
		listAgainNext(db, row.id);
		await syncMailbox(contextFor(db, backupRoot, oneFolderArchive(1, ['i1'])), row);
		const stored = db.select().from(messages).all();
		expect(stored.map((message) => [message.graphId, message.deletedAt !== null]).sort()).toEqual([
			['i1', false],
			['i2', true]
		]);
	});
});
