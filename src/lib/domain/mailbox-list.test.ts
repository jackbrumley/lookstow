import { describe, expect, it } from 'vitest';
import { MAILBOX_PAGE_SIZE, mailboxList, mailboxListQuery } from './mailbox-list.ts';
import type { MailboxSummary } from './mailboxes.ts';

function mailbox(index: number, overrides: Partial<MailboxSummary> = {}): MailboxSummary {
	return {
		id: `id${String(index)}`,
		address: `user${String(index).padStart(4, '0')}@example.com`,
		displayName: `User ${String(index)}`,
		kind: 'user',
		state: 'backed-up',
		completeness: 'complete',
		itemCount: index,
		byteCount: index * 10,
		lastSyncFinishedAt: null,
		lastSyncError: null,
		firstCopyDone: true,
		paused: false,
		goneAt: null,
		...overrides
	};
}

describe('the Mailboxes list', () => {
	it('reads its choices from the address, the last order and page given winning', () => {
		const query = mailboxListQuery(
			new URLSearchParams('q=Ann&state=all&order=address:asc&order=itemCount:desc&page=1&page=3')
		);
		expect(query).toEqual({
			search: 'Ann',
			state: 'all',
			kind: 'all',
			sort: 'itemCount',
			descending: true,
			page: 3
		});
		expect(mailboxListQuery(new URLSearchParams('state=nonsense&order=x:y')).state).toBe(
			'in-backup'
		);
	});

	it('filters, sorts and pages on the server', () => {
		const all = [
			...Array.from({ length: 250 }, (_, index) => mailbox(index)),
			mailbox(999, { state: 'out-of-scope', completeness: 'needs-look' })
		];
		const first = mailboxList(all, mailboxListQuery(new URLSearchParams('')));
		expect(first.matching).toBe(250);
		expect(first.total).toBe(251);
		expect(first.rows).toHaveLength(MAILBOX_PAGE_SIZE);
		expect(first.pageCount).toBe(3);
		expect(first.incomplete['needs-look']).toBe(1);
		const biggest = mailboxList(all, mailboxListQuery(new URLSearchParams('order=itemCount:desc')));
		expect(biggest.rows[0]?.itemCount).toBe(249);
		const tooFar = mailboxList(all, mailboxListQuery(new URLSearchParams('q=user01&page=9')));
		expect(tooFar.page).toBe(tooFar.pageCount - 1);
	});
});
