import { describe, expect, it } from 'vitest';
import { planSyncs, type Candidate } from './scheduler.ts';

const MINUTE = 60_000;
const NOW = 1_000 * MINUTE;

function mailbox(id: string, copied: boolean, finishedMinutesAgo: number | null): Candidate {
	const finished = finishedMinutesAgo === null ? null : NOW - finishedMinutesAgo * MINUTE;
	return {
		id,
		firstCopyDone: copied,
		lastSyncStartedAt: finished === null ? null : finished - MINUTE,
		lastSyncFinishedAt: finished
	};
}

const base = {
	running: new Set<string>(),
	requested: new Set<string>(),
	allRequestedAt: null,
	now: NOW,
	intervalMs: 15 * MINUTE
};

describe('planning syncs', () => {
	it('starts routine syncs that are due before first copies, oldest first', () => {
		const plan = planSyncs({
			...base,
			slots: 3,
			candidates: [
				mailbox('fresh', true, 5),
				mailbox('due-old', true, 60),
				mailbox('due-new', true, 20),
				mailbox('new', false, null)
			]
		});
		expect(plan.start).toEqual(['due-old', 'due-new', 'new']);
		expect(plan.waiting).toEqual({ requested: 0, due: 0, firstCopy: 0 });
	});

	it('keeps one slot free of first copies, so copied mailboxes are never stuck behind them', () => {
		const plan = planSyncs({
			...base,
			slots: 3,
			candidates: ['a', 'b', 'c', 'd'].map((id) => mailbox(id, false, null))
		});
		expect(plan.start).toEqual(['a', 'b']);
		expect(plan.waiting.firstCopy).toBe(2);
	});

	it('puts requested mailboxes first, even past the first-copy limit', () => {
		const plan = planSyncs({
			...base,
			slots: 2,
			running: new Set(['busy']),
			requested: new Set(['wanted']),
			candidates: [
				mailbox('busy', false, null),
				mailbox('due', true, 60),
				mailbox('wanted', false, null)
			]
		});
		expect(plan.start).toEqual(['wanted']);
		expect(plan.waiting.due).toBe(1);
	});

	it('treats every mailbox not started since Sync all now as requested', () => {
		const plan = planSyncs({
			...base,
			slots: 5,
			allRequestedAt: NOW - MINUTE,
			candidates: [mailbox('fresh', true, 2), mailbox('done-after', true, 0)]
		});
		expect(plan.start).toEqual(['fresh']);
	});

	it('lets a stopped first copy wait its interval before trying again', () => {
		const plan = planSyncs({
			...base,
			slots: 4,
			candidates: [
				{
					id: 'failed',
					firstCopyDone: false,
					lastSyncStartedAt: NOW - 3 * MINUTE,
					lastSyncFinishedAt: NOW - 2 * MINUTE
				}
			]
		});
		expect(plan.start).toEqual([]);
	});
});
