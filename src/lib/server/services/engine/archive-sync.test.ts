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
import { messages } from '../../database/schema.ts';
import { GraphClient } from '../graph/client.ts';
import { TokenSource } from '../graph/token.ts';
import { indexArchiveItems } from '../fts/fts-index.ts';
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
				value: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 1, parentMailboxUrl: MAIN }]
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
		client: new GraphClient(new TokenSource(TEST_CREDENTIALS, graph.fetch), graph.fetch, noSleep),
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
	});

	it('says which permissions to add when Microsoft refuses', async () => {
		const graph = new FakeGraph()
			.withToken()
			.on(/MBX:arc@t\/folders/, () => graphError(403, 'ErrorAccessDenied', 'Access is denied.'));
		const { row, context } = await setup(graph);
		await expect(syncMailbox(context, row)).rejects.toThrow(/MailboxItem\.Export\.All/);
	});

	it('keeps its place and reports items that could not be exported', async () => {
		const graph = archive().on(/MBX:aux@t\/exportItems$/, () =>
			json({ value: [{ itemId: 'i2', error: { code: 'ErrorItemCorrupt', message: 'Corrupt' } }] })
		);
		const { db, row, context } = await setup(graph);
		await expect(syncMailbox(context, row)).rejects.toThrow(/could not be exported/);
		const inbox = foldersOf(db, row.id).find((folder) => folder.graphId === 'inbox');
		expect(inbox?.deltaLink).toBeNull();
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
