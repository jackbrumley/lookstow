import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import type { DiscoveredMailbox } from '../graph/discovery.ts';
import { messageEvents, messages } from '../../database/schema.ts';
import { messageDetail, searchMessages } from '../messages/search.ts';
import {
	linkAllArchiveCopies,
	linkArchiveCopy,
	removeFromFolder,
	SETTLE_MS,
	settleLeftMessages
} from './archive-links.ts';
import { applyDiscovery, folderItemCounts, insertMessage, syncFolderList } from './repository.ts';

const DAY = 24 * 60 * 60_000;
const RECEIVED = Date.parse('2024-03-06T01:00:00Z');

function setup(withArchive = true) {
	const db = openDatabase(':memory:');
	const found: DiscoveredMailbox[] = [
		{
			userId: 'u',
			kind: 'user',
			address: 'jason@example.com',
			displayName: 'Jason',
			exchangeMailboxId: null
		},
		{
			userId: 'other',
			kind: 'user',
			address: 'ann@example.com',
			displayName: 'Ann',
			exchangeMailboxId: null
		}
	];
	if (withArchive) {
		found.push({
			userId: 'u',
			kind: 'archive',
			address: 'jason@example.com',
			displayName: 'Jason (archive)',
			exchangeMailboxId: 'MBX:arc'
		});
	}
	const { added } = applyDiscovery(db, found, 1);
	const byKind = (address: string, kind: string) => {
		const row = added.find((mailbox) => mailbox.address === address && mailbox.kind === kind);
		if (row === undefined) throw new Error(`no ${kind} for ${address}`);
		return row;
	};
	const folders = (mailboxId: string) => {
		const rows = syncFolderList(
			db,
			mailboxId,
			[
				{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' },
				{ graphId: 'sent', path: 'Sent Items', storagePath: 'Sent Items' }
			],
			1
		);
		const [inbox, sent] = rows;
		if (inbox === undefined || sent === undefined) throw new Error('no folders');
		return { inbox, sent };
	};
	const store = (
		mailboxId: string,
		folderId: string,
		graphId: string,
		internetMessageId: string | null,
		received = RECEIVED
	) =>
		insertMessage(db, {
			mailboxId,
			folderId,
			graphId,
			internetMessageId,
			subject: 'Hours',
			sender: 'manager@example.com',
			recipients: 'jason@example.com',
			receivedAt: new Date(received),
			filePath: `${graphId}.eml`,
			byteCount: 10,
			sha256: 'x',
			storedAt: new Date(2)
		});
	const row = (id: string) => db.select().from(messages).where(eq(messages.id, id)).get();
	const events = (id: string) =>
		db
			.select()
			.from(messageEvents)
			.where(eq(messageEvents.messageId, id))
			.all()
			.map((event) => event.kind);
	return { db, byKind, folders, store, row, events };
}

describe('one email in a mailbox and its online archive', () => {
	it('is archived, not deleted, when it leaves the mailbox and turns up in the archive', () => {
		const { db, byKind, folders, store, row, events } = setup();
		const mailbox = byKind('jason@example.com', 'user');
		const archive = byKind('jason@example.com', 'archive');
		const inbox = folders(mailbox.id).inbox;
		const archiveInbox = folders(archive.id).inbox;
		const original = store(mailbox.id, inbox.id, 'g1', '<abc@farm>');
		expect(removeFromFolder(db, mailbox.id, inbox.id, 'g1', 10 * DAY)).toBe('left');
		// The left message no longer counts as being in its folder.
		expect(folderItemCounts(db, mailbox.id).get(inbox.id)).toBeUndefined();
		const copy = store(archive.id, archiveInbox.id, 'a1', '<abc@farm>', RECEIVED + 2_000);
		expect(linkArchiveCopy(db, copy)).toBe(true);
		expect(row(original)).toMatchObject({
			archiveCopyId: copy,
			deletedAt: null,
			leftAt: new Date(10 * DAY)
		});
		expect(events(original)).toEqual(['stored', 'archived']);
		// Never settled as deleted.
		expect(settleLeftMessages(db, mailbox.id, 30 * DAY)).toBe(0);
		expect(messageDetail(db, original)?.otherCopy).toMatchObject({
			id: copy,
			mailboxKind: 'archive',
			folderPath: 'Inbox'
		});
	});

	it('links first when the archive copy is seen before the mailbox notices, then records the move once', () => {
		const { db, byKind, folders, store, row, events } = setup();
		const mailbox = byKind('jason@example.com', 'user');
		const archive = byKind('jason@example.com', 'archive');
		const inbox = folders(mailbox.id).inbox;
		const original = store(mailbox.id, inbox.id, 'g1', 'abc@farm');
		const copy = store(archive.id, folders(archive.id).inbox.id, 'a1', '<abc@farm>');
		expect(linkArchiveCopy(db, copy)).toBe(true);
		expect(events(original)).toEqual(['stored']);
		expect(removeFromFolder(db, mailbox.id, inbox.id, 'g1', 5 * DAY)).toBe('archived');
		expect(row(original)?.deletedAt).toBeNull();
		expect(events(original)).toEqual(['stored', 'archived']);
	});

	it('picks the copy in the same folder for an email sent to oneself', () => {
		const { db, byKind, folders, store, row } = setup();
		const mailbox = byKind('jason@example.com', 'user');
		const archive = byKind('jason@example.com', 'archive');
		const own = folders(mailbox.id);
		const sentCopy = store(mailbox.id, own.sent.id, 'g-sent', '<self@x>');
		const inboxCopy = store(mailbox.id, own.inbox.id, 'g-inbox', '<self@x>');
		const archived = store(archive.id, folders(archive.id).inbox.id, 'a1', '<self@x>');
		linkArchiveCopy(db, archived);
		expect(row(inboxCopy)?.archiveCopyId).toBe(archived);
		expect(row(sentCopy)?.archiveCopyId).toBeNull();
	});

	it('never links without a Message-ID, across people, or far apart in time; those settle as deleted', () => {
		const { db, byKind, folders, store, row, events } = setup();
		const mailbox = byKind('jason@example.com', 'user');
		const archive = byKind('jason@example.com', 'archive');
		const ann = byKind('ann@example.com', 'user');
		const inbox = folders(mailbox.id).inbox;
		const archiveInbox = folders(archive.id).inbox;
		const noId = store(mailbox.id, inbox.id, 'g1', null);
		const late = store(mailbox.id, inbox.id, 'g2', '<late@x>', RECEIVED);
		store(ann.id, folders(ann.id).inbox.id, 'g3', '<ann@x>');
		expect(linkArchiveCopy(db, store(archive.id, archiveInbox.id, 'a1', null))).toBe(false);
		expect(
			linkArchiveCopy(db, store(archive.id, archiveInbox.id, 'a2', '<late@x>', RECEIVED + 60_000))
		).toBe(false);
		expect(linkArchiveCopy(db, store(archive.id, archiveInbox.id, 'a3', '<ann@x>'))).toBe(false);
		removeFromFolder(db, mailbox.id, inbox.id, 'g1', 1 * DAY);
		removeFromFolder(db, mailbox.id, inbox.id, 'g2', 1 * DAY);
		expect(settleLeftMessages(db, mailbox.id, 1 * DAY + SETTLE_MS - 1)).toBe(0);
		expect(settleLeftMessages(db, mailbox.id, 1 * DAY + SETTLE_MS + 1)).toBe(2);
		expect(row(noId)?.deletedAt).toEqual(new Date(1 * DAY));
		expect(events(late)).toEqual(['stored', 'deleted']);
	});

	it('deletes at once in a mailbox with no online archive, as before', () => {
		const { db, byKind, folders, store, row } = setup(false);
		const mailbox = byKind('jason@example.com', 'user');
		const inbox = folders(mailbox.id).inbox;
		const id = store(mailbox.id, inbox.id, 'g1', '<x@y>');
		expect(removeFromFolder(db, mailbox.id, inbox.id, 'g1', 3)).toBe('deleted');
		expect(row(id)?.deletedAt).toEqual(new Date(3));
	});

	it('turns an old false "deleted" into "archived" at upgrade, and running it again changes nothing', async () => {
		const { db, byKind, folders, store, row, events } = setup();
		const mailbox = byKind('jason@example.com', 'user');
		const archive = byKind('jason@example.com', 'archive');
		const inbox = folders(mailbox.id).inbox;
		const original = store(mailbox.id, inbox.id, 'g1', '<abc@farm>');
		// What an earlier Lookstow did: marked it deleted when the archive policy moved it.
		db.update(messages)
			.set({ deletedAt: new Date(4 * DAY) })
			.where(eq(messages.id, original))
			.run();
		db.insert(messageEvents)
			.values({
				id: 'e-old',
				messageId: original,
				mailboxId: mailbox.id,
				at: new Date(4 * DAY),
				kind: 'deleted',
				fromFolderPath: 'Inbox',
				toFolderPath: null
			})
			.run();
		store(archive.id, folders(archive.id).inbox.id, 'a1', '<abc@farm>');
		expect(await linkAllArchiveCopies(db, () => false)).toEqual({ checked: 1, linked: 1 });
		expect(row(original)).toMatchObject({ deletedAt: null, leftAt: new Date(4 * DAY) });
		expect(events(original)).toEqual(['stored', 'archived']);
		expect(await linkAllArchiveCopies(db, () => false)).toEqual({ checked: 1, linked: 0 });
	});

	it('is listed once in search, as the mailbox copy, unless the archive is searched on its own', () => {
		const { db, byKind, folders, store } = setup();
		const mailbox = byKind('jason@example.com', 'user');
		const archive = byKind('jason@example.com', 'archive');
		const original = store(mailbox.id, folders(mailbox.id).inbox.id, 'g1', '<abc@farm>');
		const copy = store(archive.id, folders(archive.id).inbox.id, 'a1', '<abc@farm>');
		linkArchiveCopy(db, copy);
		const query = {
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
		expect(searchMessages(db, query, 0).hits.map((hit) => hit.id)).toEqual([original]);
		expect(
			searchMessages(db, { ...query, mailboxId: archive.id }, 0).hits.map((hit) => hit.id)
		).toEqual([copy]);
	});
});
