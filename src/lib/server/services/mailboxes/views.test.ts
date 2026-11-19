import { removeFromFolder } from './archive-links.ts';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../database/connection.ts';
import { activity, mailFolders } from '../../database/schema.ts';
import { applyDiscovery, foldersOf, insertMessage, syncFolderList } from './repository.ts';
import {
	RECHECK_AFTER_MS,
	REPORT_AFTER_MS,
	explainGap,
	recheckDue,
	recordFolderCounts,
	reportLastingDifferences
} from './completeness.ts';
import { recordItemFailure } from './item-failures.ts';
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
	const folder = () => {
		const row = foldersOf(db, mailbox.id)[0];
		if (row === undefined) throw new Error('no folder');
		return row;
	};
	return { db, mailbox, inbox, folder };
}

const none = { waiting: 0, givenUp: 0 };

describe('explaining a difference', () => {
	it('names matches, unchecked folders and gaps nothing explains', () => {
		expect(explainGap(2, null, none, null)).toEqual({ kind: 'unchecked' });
		expect(explainGap(2, 2, none, null)).toEqual({ kind: 'match' });
		expect(explainGap(2, 3, none, null)).toEqual({ kind: 'unexplained', stored: 2, source: 3 });
		// More stored than Microsoft counts is never explained by items waiting.
		expect(explainGap(3, 2, { waiting: 5, givenUp: 0 }, 5)).toEqual({
			kind: 'unexplained',
			stored: 3,
			source: 2
		});
	});

	it('items waiting to be copied again and items that are not messages explain a gap', () => {
		expect(explainGap(2, 5, { waiting: 1, givenUp: 1 }, 1)).toEqual({
			kind: 'explained',
			waiting: 1,
			givenUp: 1,
			otherItems: 1
		});
		expect(explainGap(2, 6, { waiting: 1, givenUp: 1 }, 1).kind).toBe('unexplained');
	});
});

describe('the completeness check', () => {
	it('a gap nothing explains is Checking: both counts, when it started, nothing to do yet', () => {
		const { db, mailbox, inbox } = setup();
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 3, listed: null }], 2);
		const detail = mailboxDetail(db, mailbox.id, '/backup', () => false, 3);
		expect(detail?.completeness).toBe('checking');
		expect(detail?.folders).toEqual([
			expect.objectContaining({
				path: 'Inbox',
				itemCount: 2,
				sourceCount: 3,
				gap: {
					kind: 'checking',
					stored: 2,
					source: 3,
					since: new Date(2).toISOString(),
					recheckedAt: null
				}
			})
		]);
		const totals = mailboxTotals(mailboxSummaries(db, () => false, 3));
		expect(totals).toMatchObject({ completenessChecking: 1, completenessNeedsLook: 0 });
	});

	it('it needs a look only when still there a day after a re-read', () => {
		const { db, mailbox, inbox } = setup();
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 3, listed: null }], 0);
		// A day on, but never read again: still Checking.
		expect(mailboxSummaries(db, () => false, REPORT_AFTER_MS)[0]?.completeness).toBe('checking');
		db.update(mailFolders)
			.set({ recheckedAt: new Date(RECHECK_AFTER_MS) })
			.where(eq(mailFolders.id, inbox.id))
			.run();
		expect(mailboxSummaries(db, () => false, REPORT_AFTER_MS - 1)[0]?.completeness).toBe(
			'checking'
		);
		expect(mailboxSummaries(db, () => false, REPORT_AFTER_MS)[0]?.completeness).toBe('needs-look');
		expect(
			mailboxDetail(db, mailbox.id, '/backup', () => false, REPORT_AFTER_MS)?.folders[0]?.gap
		).toEqual({
			kind: 'needs-look',
			stored: 2,
			source: 3,
			since: new Date(0).toISOString(),
			recheckedAt: new Date(RECHECK_AFTER_MS).toISOString()
		});
	});

	it('a hidden or non-mail folder is not compared: its old count and difference are cleared', () => {
		const { db, mailbox, inbox, folder } = setup();
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 2926, listed: null }], 2);
		expect(folder().differsSince).not.toBeNull();
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: null, listed: null }], 3);
		expect(folder()).toMatchObject({ sourceCount: null, differsSince: null });
		expect(mailboxSummaries(db, () => false, 4)[0]?.completeness).toBe('complete');
		expect(mailboxDetail(db, mailbox.id, '/backup', () => false, 4)?.folders[0]?.gap).toEqual({
			kind: 'unchecked'
		});
	});

	it('matches when the counts agree, and counts only messages not deleted at the source', () => {
		const { db, mailbox, inbox, folder } = setup();
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 3, listed: null }], 2);
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 2, listed: null }], 3);
		expect(mailboxSummaries(db, () => false, 5)[0]?.completeness).toBe('complete');
		expect(folder().differsSince).toBeNull();
		removeFromFolder(db, mailbox.id, inbox.id, 'm2', 3);
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 1, listed: null }], 4);
		expect(mailboxSummaries(db, () => false, 5)[0]?.completeness).toBe('complete');
	});

	it('a folder never checked does not count as different', () => {
		const { db } = setup();
		expect(mailboxSummaries(db, () => false, 5)[0]?.completeness).toBe('complete');
	});

	it('items that failed to copy explain a gap, so the mailbox does not differ', () => {
		const { db, mailbox, inbox } = setup();
		recordItemFailure(
			db,
			{
				mailboxId: mailbox.id,
				folderId: inbox.id,
				graphId: 'm3',
				subject: 'Third',
				receivedAt: null,
				error: 'boom'
			},
			2
		);
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 3, listed: null }], 3);
		const detail = mailboxDetail(db, mailbox.id, '/backup', () => false, 4);
		expect(detail?.completeness).toBe('complete');
		expect(detail?.folders[0]?.gap).toEqual({
			kind: 'explained',
			waiting: 1,
			givenUp: 0,
			otherItems: 0
		});
	});

	it('a full listing measures the items that are not messages, and keeps them for later syncs', () => {
		const { db, mailbox, inbox, folder } = setup();
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 4, listed: 2 }], 2);
		expect(folder()).toMatchObject({ otherItemCount: 2, differsSince: null });
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 4, listed: null }], 3);
		expect(folder()).toMatchObject({ otherItemCount: 2, differsSince: null });
	});
});

describe('repairing a lasting difference', () => {
	it('reads a folder again only after the gap has lasted, and at most once a day', () => {
		const since = new Date(0);
		expect(recheckDue({ differsSince: null, recheckedAt: null }, RECHECK_AFTER_MS)).toBe(false);
		expect(recheckDue({ differsSince: since, recheckedAt: null }, RECHECK_AFTER_MS - 1)).toBe(
			false
		);
		expect(recheckDue({ differsSince: since, recheckedAt: null }, RECHECK_AFTER_MS)).toBe(true);
		const rechecked = new Date(RECHECK_AFTER_MS);
		expect(recheckDue({ differsSince: since, recheckedAt: rechecked }, RECHECK_AFTER_MS * 2)).toBe(
			false
		);
		expect(
			recheckDue({ differsSince: since, recheckedAt: rechecked }, RECHECK_AFTER_MS + 86_400_000)
		).toBe(true);
	});

	it('reports a difference that outlasts a re-read by a day, once, and clears when it matches', () => {
		const { db, mailbox, inbox } = setup();
		recordFolderCounts(db, mailbox.id, [{ folderId: inbox.id, count: 3, listed: null }], 0);
		// Not read again yet: nothing to report however long it lasts.
		expect(reportLastingDifferences(db, mailbox.id, REPORT_AFTER_MS * 2)).toBe(0);
		db.update(mailFolders)
			.set({ recheckedAt: new Date(RECHECK_AFTER_MS) })
			.where(eq(mailFolders.id, inbox.id))
			.run();
		expect(reportLastingDifferences(db, mailbox.id, REPORT_AFTER_MS - 1)).toBe(0);
		expect(reportLastingDifferences(db, mailbox.id, REPORT_AFTER_MS)).toBe(1);
		expect(reportLastingDifferences(db, mailbox.id, REPORT_AFTER_MS + 1)).toBe(0);
		const entries = db.select().from(activity).where(eq(activity.kind, 'completeness')).all();
		expect(entries).toEqual([
			expect.objectContaining({
				level: 'error',
				summary: 'ann@example.com: Inbox still differs from Microsoft’s count after a day'
			})
		]);
		recordFolderCounts(
			db,
			mailbox.id,
			[{ folderId: inbox.id, count: 2, listed: null }],
			REPORT_AFTER_MS + 2
		);
		expect(foldersOf(db, mailbox.id)[0]?.differenceAlertedAt).toBeNull();
	});
});
