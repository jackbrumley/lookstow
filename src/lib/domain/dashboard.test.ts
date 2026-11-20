import { describe, expect, it } from 'vitest';
import { dashboardOverview, splitProblems } from './dashboard.ts';
import type { MailboxSummary } from './mailboxes.ts';

function mailbox(id: string, overrides: Partial<MailboxSummary>): MailboxSummary {
	return {
		id,
		address: `${id}@example.com`,
		displayName: id,
		kind: 'user',
		state: 'backed-up',
		lastSyncFinishedAt: null,
		lastSyncError: null,
		itemCount: 10,
		byteCount: 100,
		firstCopyDone: true,
		paused: false,
		goneAt: null,
		completeness: 'complete',
		...overrides
	};
}

describe('the dashboard', () => {
	it('counts a copied mailbox as fully copied while it syncs or after a failed sync', () => {
		const overview = dashboardOverview(
			[
				mailbox('ann', { state: 'syncing' }),
				mailbox('bob', { state: 'failed', lastSyncError: 'Microsoft refused it' }),
				mailbox('cat', { state: 'syncing', firstCopyDone: false, kind: 'archive' }),
				mailbox('dan', { state: 'out-of-scope', firstCopyDone: false })
			],
			new Map([['cat', { done: 61, total: 82 }]])
		);
		expect(overview.inBackup).toBe(3);
		expect(overview.found).toBe(4);
		expect(overview.fullyCopied).toBe(2);
		expect(overview.firstCopies).toEqual([
			{
				id: 'cat',
				address: 'cat@example.com',
				kind: 'archive',
				foldersDone: 61,
				foldersTotal: 82,
				syncing: true
			}
		]);
		expect(overview.attention.map((item) => item.id)).toEqual(['bob']);
	});

	it('keeps old errors apart from those about a mailbox that still needs attention', () => {
		const entry = (id: string, mailboxId: string | null) => ({
			id,
			at: '2026-11-20T00:00:00.000Z',
			level: 'error' as const,
			kind: 'sync',
			actor: 'system',
			summary: id,
			detail: null,
			mailboxId
		});
		const attention = [
			{ id: 'bob', address: 'bob@example.com', kind: 'user', problem: '', what: '' }
		];
		const split = splitProblems(
			[entry('e1', 'bob'), entry('e2', 'ann'), entry('e3', null)],
			attention
		);
		expect(split.open.map((item) => item.id)).toEqual(['e1']);
		expect(split.cleared.map((item) => item.id)).toEqual(['e2', 'e3']);
	});
});
