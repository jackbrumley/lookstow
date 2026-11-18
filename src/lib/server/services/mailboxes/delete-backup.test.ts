import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { messages } from '../../database/schema.ts';
import { applyDiscovery, insertMessage, mailboxById, syncFolderList } from './repository.ts';
import { confirmsDeletion, deleteMailboxBackup } from './delete-backup.ts';

describe('deleting a mailbox backup', () => {
	it('removes its folder and index rows, and keeps the mailbox listed', async () => {
		const db = openDatabase(':memory:');
		const root = await mkdtemp(join(tmpdir(), 'lookstow-delete-'));
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
		const [folder] = syncFolderList(
			db,
			mailbox.id,
			[{ graphId: 'f', path: 'Inbox', storagePath: 'Inbox' }],
			1
		);
		if (folder === undefined) throw new Error('no folder');
		await mkdir(join(root, 'ann@example.com', 'Inbox'), { recursive: true });
		await writeFile(join(root, 'ann@example.com', 'Inbox', 'a.eml'), 'x');
		insertMessage(db, {
			mailboxId: mailbox.id,
			folderId: folder.id,
			graphId: 'm',
			internetMessageId: null,
			subject: 's',
			sender: 'b',
			receivedAt: null,
			filePath: 'ann@example.com/Inbox/a.eml',
			byteCount: 1,
			sha256: 'x',
			storedAt: new Date(1)
		});
		await deleteMailboxBackup(db, mailbox, root, 'console');
		expect(existsSync(join(root, 'ann@example.com'))).toBe(false);
		expect(db.select().from(messages).all()).toEqual([]);
		expect(mailboxById(db, mailbox.id)).toMatchObject({ itemCount: 0, firstCopyDone: false });
	});

	it('only accepts the exact address as confirmation', () => {
		expect(confirmsDeletion(' Ann@Example.com ', 'ann@example.com')).toBe(true);
		expect(confirmsDeletion('ann', 'ann@example.com')).toBe(false);
	});
});
