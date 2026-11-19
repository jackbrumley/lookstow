import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import {
	applyDiscovery,
	insertMessage,
	markMessageDeleted,
	setFolderSourceCounts,
	syncFolderList
} from './repository.ts';
import { mailboxDetail, mailboxSummaries, mailboxTotals } from './views.ts';

function setup() {
	const db = openDatabase(':memory:');
	const mailbox = applyDiscovery(
		db,
		[
			{
				userId: 'u1',
				kind: 'user',
				address: 'ann@example.com',
				displayName: 'Ann',
				exchangeMailboxId: null
			}
		],
		1
	).added[0];
	if (mailbox === undefined) throw new Error('no mailbox');
	const [inbox] = syncFolderList(
		db,
		mailbox.id,
		[{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' }],
		1
	);
	if (inbox === undefined) throw new Error('no folder');
	for (const graphId of ['m1', 'm2']) {
		insertMessage(db, {
			mailboxId: mailbox.id,
			folderId: inbox.id,
			graphId,
			internetMessageId: null,
			subject: 's',
			sender: 'b',
			receivedAt: null,
			filePath: `ann@example.com/2026/11/${graphId}.eml`,
			byteCount: 1,
			sha256: 'x',
			storedAt: new Date(1)
		});
	}
	return { db, mailbox, inbox };
}

describe('the completeness check', () => {
	it('a folder that differs from Microsoft shows both counts', () => {
		const { db, mailbox, inbox } = setup();
		setFolderSourceCounts(db, [{ folderId: inbox.id, count: 3 }], 2);
		const detail = mailboxDetail(db, mailbox.id, '/backup', () => false);
		expect(detail?.differsFromMicrosoft).toBe(true);
		expect(detail?.folders).toEqual([
			expect.objectContaining({ path: 'Inbox', itemCount: 2, sourceCount: 3 })
		]);
		expect(mailboxTotals(mailboxSummaries(db, () => false)).differingFromMicrosoft).toBe(1);
	});

	it('matches when the counts agree, and counts only messages not deleted at the source', () => {
		const { db, mailbox, inbox } = setup();
		setFolderSourceCounts(db, [{ folderId: inbox.id, count: 2 }], 2);
		expect(mailboxSummaries(db, () => false)[0]?.differsFromMicrosoft).toBe(false);
		markMessageDeleted(db, mailbox.id, inbox.id, 'm2', 3);
		setFolderSourceCounts(db, [{ folderId: inbox.id, count: 1 }], 4);
		expect(mailboxSummaries(db, () => false)[0]?.differsFromMicrosoft).toBe(false);
	});

	it('a folder never checked does not count as different', () => {
		const { db } = setup();
		expect(mailboxSummaries(db, () => false)[0]?.differsFromMicrosoft).toBe(false);
	});
});
