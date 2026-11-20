import { removeFromFolder } from '../mailboxes/archive-links.ts';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import {
	applyDiscovery,
	insertMessage,
	setMessageIndex,
	syncFolderList
} from '../mailboxes/repository.ts';
import { headersCursor, indexNewHeaders } from '../search-index/headers.ts';
import { messageDetail, searchMessages } from './search.ts';
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

function seed() {
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
	const folders = syncFolderList(
		db,
		mailbox.id,
		[
			{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' },
			{ graphId: 'payroll', path: 'Inbox/Payroll 50%', storagePath: 'Inbox/Payroll 50%' }
		],
		1
	);
	const [inbox, payroll] = folders.sort((a, b) => a.path.localeCompare(b.path));
	if (inbox === undefined || payroll === undefined) throw new Error('no folders');
	const message = (
		graphId: string,
		folderId: string,
		subject: string,
		sender: string,
		recipients: string,
		day: string
	) =>
		insertMessage(db, {
			mailboxId: mailbox.id,
			folderId,
			graphId,
			internetMessageId: `<${graphId}@example.com>`,
			subject,
			sender,
			recipients,
			receivedAt: new Date(`${day}T10:00:00Z`),
			filePath: `ann@example.com/${graphId}.eml`,
			byteCount: 100,
			sha256: 'x',
			storedAt: new Date(2)
		});
	message(
		'm1',
		inbox.id,
		'November pay run',
		'payroll@example.com',
		'ann@example.com',
		'2026-11-03'
	);
	message(
		'm2',
		payroll.id,
		'Timesheets',
		'bob@example.com',
		'payroll@example.com fin@example.com',
		'2026-11-10'
	);
	message('m3', inbox.id, 'Lunch', 'carol@example.com', 'ann@example.com', '2026-10-01');
	removeFromFolder(db, mailbox.id, inbox.id, 'm3', 5);
	return { db, mailbox, inbox };
}

describe('searching messages', () => {
	it('finds by words in the subject, sender or recipients, newest first', () => {
		const { db } = seed();
		const { hits, total } = searchMessages(db, { ...EMPTY, text: 'payroll' }, 0);
		expect(total).toBe(2);
		expect(hits.map((hit) => hit.subject)).toEqual(['Timesheets', 'November pay run']);
	});

	it('narrows by from, to, folder, date and Message-ID', () => {
		const { db } = seed();
		const subjects = (query: Partial<MessageQuery>) =>
			searchMessages(db, { ...EMPTY, ...query }, 0).hits.map((hit) => hit.subject);
		expect(subjects({ from: 'BOB@' })).toEqual(['Timesheets']);
		expect(subjects({ to: 'fin@' })).toEqual(['Timesheets']);
		expect(subjects({ folder: '50%' })).toEqual(['Timesheets']);
		expect(subjects({ folder: '5_' })).toEqual([]);
		expect(subjects({ after: '2026-11-04' })).toEqual(['Timesheets']);
		expect(subjects({ before: '2026-11-03' })).toEqual(['November pay run']);
		expect(subjects({ messageId: '<m2@example.com>' })).toEqual(['Timesheets']);
	});

	it('leaves out messages deleted at the source unless asked', () => {
		const { db } = seed();
		expect(searchMessages(db, { ...EMPTY, text: 'lunch' }, 0).total).toBe(0);
		expect(searchMessages(db, { ...EMPTY, text: 'lunch', includeDeleted: true }, 0).total).toBe(1);
	});

	it('shows a message with its folder history', () => {
		const { db } = seed();
		const hit = searchMessages(db, { ...EMPTY, text: 'lunch', includeDeleted: true }, 0).hits[0];
		const detail = messageDetail(db, hit?.id ?? '');
		expect(detail?.history.map((event) => event.kind)).toEqual(['stored', 'deleted']);
		expect(detail?.folderPath).toBe('Inbox');
	});
});

describe('searching with the search index built', () => {
	it('finds the same messages through the index as without it', () => {
		const { db } = seed();
		const subjects = (query: Partial<MessageQuery>) =>
			searchMessages(db, { ...EMPTY, ...query }, 0).hits.map((hit) => hit.subject);
		const asked: Partial<MessageQuery>[] = [
			{ text: 'payroll' },
			{ text: 'PAY run' },
			{ from: 'BOB@' },
			{ to: 'fin@' },
			{ to: 'yroll@exa' },
			{ subject: 'sheet' },
			{ text: 'lunch', includeDeleted: true },
			{ from: 'bo' }
		];
		const before = asked.map(subjects);
		expect(indexNewHeaders(db)).toBe(3);
		expect(headersCursor(db)).toBeGreaterThan(0);
		expect(asked.map(subjects)).toEqual(before);
	});

	it('finds a message stored after the index last ran, and one whose subject changed', () => {
		const { db, mailbox, inbox } = seed();
		indexNewHeaders(db);
		const later = insertMessage(db, {
			mailboxId: mailbox.id,
			folderId: inbox.id,
			graphId: 'm4',
			internetMessageId: '<m4@example.com>',
			subject: 'Overtime claims',
			sender: 'dave@example.com',
			recipients: 'ann@example.com',
			receivedAt: new Date('2026-11-12T10:00:00Z'),
			filePath: 'ann@example.com/m4.eml',
			byteCount: 100,
			sha256: 'x',
			storedAt: new Date(3)
		});
		expect(searchMessages(db, { ...EMPTY, text: 'overtime' }, 0).total).toBe(1);
		indexNewHeaders(db);
		setMessageIndex(db, later, {
			subject: 'Rostered days off',
			sender: 'dave@example.com',
			recipients: 'ann@example.com',
			internetMessageId: '<m4@example.com>',
			receivedAt: new Date('2026-11-12T10:00:00Z')
		});
		expect(searchMessages(db, { ...EMPTY, text: 'overtime' }, 0).total).toBe(0);
		expect(searchMessages(db, { ...EMPTY, text: 'rostered' }, 0).total).toBe(1);
	});
});
