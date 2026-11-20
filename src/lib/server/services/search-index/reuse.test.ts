import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import {
	applyDiscovery,
	clearMailboxBackup,
	insertMessage,
	syncFolderList
} from '../mailboxes/repository.ts';
import { searchMessages } from '../messages/search.ts';
import { indexNewHeaders } from './headers.ts';
import type { MessageQuery } from '../../../domain/messages.ts';

const EMPTY: MessageQuery = {
	mailboxId: null,
	text: '',
	from: '',
	to: '',
	subject: '',
	folder: '',
	messageId: '',
	after: '',
	before: '',
	includeDeleted: false
};

describe('the search index after a deleted backup', () => {
	it('finds new messages that reuse the row numbers the deleted backup freed', () => {
		const db = openDatabase(':memory:');
		const added = applyDiscovery(
			db,
			['ann', 'bob'].map((name) => ({
				userId: name,
				kind: 'user' as const,
				address: `${name}@example.com`,
				displayName: name,
				exchangeMailboxId: null
			})),
			1
		).added;
		const store = (mailboxIndex: number, subject: string, count: number) => {
			const mailbox = added[mailboxIndex];
			if (mailbox === undefined) throw new Error('no mailbox');
			const folder = syncFolderList(
				db,
				mailbox.id,
				[{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' }],
				1
			)[0];
			if (folder === undefined) throw new Error('no folder');
			for (let index = 0; index < count; index += 1) {
				insertMessage(db, {
					mailboxId: mailbox.id,
					folderId: folder.id,
					graphId: `${subject}${String(index)}`,
					internetMessageId: null,
					subject: `${subject} ${String(index)}`,
					sender: 'someone@example.com',
					recipients: mailbox.address,
					receivedAt: new Date(index),
					filePath: `${mailbox.address}/${subject}${String(index)}.eml`,
					byteCount: 1,
					sha256: 'x',
					storedAt: new Date(index)
				});
			}
			return mailbox.id;
		};
		store(0, 'Lunch', 10);
		const bob = store(1, 'Coffee', 10);
		while (indexNewHeaders(db) > 0);
		clearMailboxBackup(db, bob);
		store(0, 'Zebrafish', 15);
		while (indexNewHeaders(db) > 0);
		expect(searchMessages(db, { ...EMPTY, text: 'zebrafish' }, 0).total).toBe(15);
	});
});
