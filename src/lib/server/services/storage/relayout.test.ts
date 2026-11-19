import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { messages } from '../../database/schema.ts';
import { applyDiscovery, insertMessage, syncFolderList } from '../mailboxes/repository.ts';
import { messageFileName, resolveStoragePath } from './eml-store.ts';
import { countOldLayout, refileArchiveItems, relayoutFiles } from './relayout.ts';

const MAY = Date.parse('2024-05-06T07:08:09Z');

async function setup() {
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
			}
		],
		1
	);
	const mailbox = added[0];
	if (mailbox === undefined) throw new Error('no mailbox');
	const [inbox] = syncFolderList(
		db,
		mailbox.id,
		[{ graphId: 'inbox', path: 'Inbox/Projects', storagePath: 'Inbox/Projects' }],
		1
	);
	if (inbox === undefined) throw new Error('no folder');
	const root = await mkdtemp(join(tmpdir(), 'lookstow-relayout-'));
	const store = async (graphId: string, oldPath: string, body: string | null) => {
		if (body !== null) {
			const file = resolveStoragePath(root, oldPath);
			await mkdir(join(file, '..'), { recursive: true });
			await writeFile(file, body);
		}
		insertMessage(db, {
			mailboxId: mailbox.id,
			folderId: inbox.id,
			graphId,
			internetMessageId: null,
			subject: `Subject ${graphId}`,
			sender: 'bob@example.com',
			recipients: '',
			receivedAt: new Date(MAY),
			filePath: oldPath,
			byteCount: 4,
			sha256: 'x',
			storedAt: new Date(1)
		});
	};
	return { db, root, store };
}

const quiet = { stopping: () => false, progress: () => undefined };

describe('moving old files into the date layout', () => {
	it('moves each old file, records its new path, and removes the emptied folders', async () => {
		const { db, root, store } = await setup();
		await store('m1', 'ann@example.com/Inbox/Projects/2024/2024-05-06_070809_one.eml', 'one!');
		const fresh = `ann@example.com/${messageFileName(MAY, 'Subject m2', 'm2')}`;
		await store('m2', fresh, 'two!');
		expect(countOldLayout(db)).toBe(1);

		const problems: string[] = [];
		const outcome = await relayoutFiles(db, root, {
			...quiet,
			problem: (message) => problems.push(message)
		});
		expect(outcome).toMatchObject({ total: 1, moved: 1, problems: 0, stopped: false });
		expect(problems).toEqual([]);

		const moved = db
			.select()
			.from(messages)
			.all()
			.find((row) => row.graphId === 'm1');
		expect(moved?.filePath).toBe(`ann@example.com/${messageFileName(MAY, 'Subject m1', 'm1')}`);
		expect(moved?.filePath).toMatch(/^ann@example.com\/2024\/05\/2024-05-06_070809_/);
		expect(await readFile(resolveStoragePath(root, moved?.filePath ?? ''), 'utf8')).toBe('one!');
		// Inbox/Projects/2024 is gone; only the date folders are left.
		expect(await readdir(join(root, 'ann@example.com'))).toEqual(['2024']);
		expect(countOldLayout(db)).toBe(0);

		// A second run has nothing to do.
		expect(await relayoutFiles(db, root, { ...quiet, problem: () => undefined })).toMatchObject({
			total: 0,
			moved: 0
		});
	});

	it('finishes a move stopped between the rename and the database, and reports missing files', async () => {
		const { db, root, store } = await setup();
		// Stopped half-way last time: the file is already at its new path.
		const target = `ann@example.com/${messageFileName(MAY, 'Subject m1', 'm1')}`;
		await mkdir(join(resolveStoragePath(root, target), '..'), { recursive: true });
		await writeFile(resolveStoragePath(root, target), 'one!');
		await store('m1', 'ann@example.com/Inbox/old-one.eml', null);
		// Missing altogether.
		await store('m2', 'ann@example.com/Inbox/old-two.eml', null);

		const problems: string[] = [];
		const outcome = await relayoutFiles(db, root, {
			...quiet,
			problem: (message) => problems.push(message)
		});
		expect(outcome).toMatchObject({ total: 2, moved: 1, problems: 1 });
		expect(problems).toEqual([
			'ann@example.com/Inbox/old-two.eml is missing from the backup folder'
		]);
		const paths = db
			.select()
			.from(messages)
			.all()
			.map((row) => row.filePath)
			.sort();
		expect(paths).toEqual(['ann@example.com/Inbox/old-two.eml', target].sort());
	});

	it('stops when asked and carries on next time', async () => {
		const { db, root, store } = await setup();
		await store('m1', 'ann@example.com/Inbox/a.eml', 'a');
		await store('m2', 'ann@example.com/Inbox/b.eml', 'b');
		let checks = 0;
		const first = await relayoutFiles(db, root, {
			stopping: () => ++checks > 1,
			progress: () => undefined,
			problem: () => undefined
		});
		expect(first).toMatchObject({ moved: 1, stopped: true });
		const second = await relayoutFiles(db, root, { ...quiet, problem: () => undefined });
		expect(second).toMatchObject({ total: 1, moved: 1, stopped: false });
	});
});

describe('filing archive items by the date they were received', () => {
	it('moves each to its received month, keeps the rest of its name, and leaves the rest alone', async () => {
		const db = openDatabase(':memory:');
		const { added } = applyDiscovery(
			db,
			[
				{
					userId: 'u',
					kind: 'archive',
					address: 'ann@example.com',
					displayName: 'Ann (archive)',
					exchangeMailboxId: 'MBX:a@b'
				}
			],
			1
		);
		const archive = added[0];
		if (archive === undefined) throw new Error('no archive');
		const [folder] = syncFolderList(
			db,
			archive.id,
			[{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' }],
			1
		);
		if (folder === undefined) throw new Error('no folder');
		const root = await mkdtemp(join(tmpdir(), 'lookstow-refile-'));
		const store = async (graphId: string, path: string, received: number | null) => {
			const file = resolveStoragePath(root, path);
			await mkdir(join(file, '..'), { recursive: true });
			await writeFile(file, `fts ${graphId}`);
			insertMessage(db, {
				mailboxId: archive.id,
				folderId: folder.id,
				graphId,
				internetMessageId: null,
				subject: '',
				sender: '',
				recipients: '',
				receivedAt: received === null ? null : new Date(received),
				filePath: path,
				byteCount: 5,
				sha256: 'x',
				storedAt: new Date(1)
			});
		};
		const box = 'ann@example.com (archive)';
		// Filed under the archive date (2020); received in 2018.
		await store(
			'old',
			`${box}/2020/08/2020-08-26_132355_IPM.Note_aaaa.fts`,
			Date.parse('2018-08-27T03:04:05Z')
		);
		// Already under its received date.
		await store(
			'right',
			`${box}/2019/01/2019-01-02_000000_IPM.Note_bbbb.fts`,
			Date.parse('2019-01-02T00:00:00Z')
		);
		// Received date unknown.
		await store('unknown', `${box}/2020/09/2020-09-01_000000_IPM.Note_cccc.fts`, null);
		const outcome = await refileArchiveItems(db, root, {
			stopping: () => false,
			progress: () => undefined,
			problem: () => undefined
		});
		expect(outcome).toMatchObject({ total: 1, moved: 1, problems: 0 });
		const paths = Object.fromEntries(
			db
				.select()
				.from(messages)
				.all()
				.map((row) => [row.graphId, row.filePath])
		);
		expect(paths).toEqual({
			old: `${box}/2018/08/2018-08-27_030405_IPM.Note_aaaa.fts`,
			right: `${box}/2019/01/2019-01-02_000000_IPM.Note_bbbb.fts`,
			unknown: `${box}/2020/09/2020-09-01_000000_IPM.Note_cccc.fts`
		});
		expect(await readFile(resolveStoragePath(root, paths['old'] ?? ''), 'utf8')).toBe('fts old');
		// 2020/08 is empty now and removed; the rest stay.
		expect((await readdir(join(root, box))).sort()).toEqual(['2018', '2019', '2020']);
		expect(await readdir(join(root, box, '2020'))).toEqual(['09']);
		// Nothing left to move the second time.
		expect(
			(
				await refileArchiveItems(db, root, {
					stopping: () => false,
					progress: () => undefined,
					problem: () => undefined
				})
			).total
		).toBe(0);
	});
});
