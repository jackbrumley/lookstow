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
import { openDatabase } from '../../database/connection.ts';
import { messages } from '../../database/schema.ts';
import { GraphClient } from '../graph/client.ts';
import { TokenSource } from '../graph/token.ts';
import { applyDiscovery, foldersOf } from '../mailboxes/repository.ts';
import { syncMailbox, type SyncContext } from './mailbox-sync.ts';

const BETA = 'https://graph.microsoft.com/beta/admin/exchange/mailboxes';
const MAIN = `${BETA}/MBX:arc@t`;
const AUX = `${BETA}/MBX:aux@t`;

function item(id: string, created: string) {
	return { id, type: 'IPM.Note', size: 10, createdDateTime: created };
}

function exported(id: string) {
	return { itemId: id, data: Buffer.from(`fts of ${id}`).toString('base64') };
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
		expect(first?.filePath).toMatch(
			/^ann@example.com \(archive\)\/2020\/02\/2020-02-03_040506_IPM.Note_[0-9a-f]{10}\.fts$/
		);
		expect(await readFile(join(backupRoot, ...(first?.filePath ?? '').split('/')), 'utf8')).toBe(
			'fts of i1'
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
