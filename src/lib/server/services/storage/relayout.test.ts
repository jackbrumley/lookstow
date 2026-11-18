import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { messages } from '../../database/schema.ts';
import { applyDiscovery, insertMessage, syncFolderList } from '../mailboxes/repository.ts';
import { messageFileName, resolveStoragePath } from './eml-store.ts';
import { countOldLayout, relayoutFiles } from './relayout.ts';

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
