import { describe, expect, it } from 'vitest';
import { failureBackoffMs, planSyncs, type Candidate } from './scheduler.ts';

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
		expect(plan.waiting).toEqual({
			requested: 0,
			due: 0,
			firstCopy: 0,
			later: 1,
			nextDueAt: NOW + 10 * MINUTE
		});
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

describe('a failing mailbox', () => {
	it('waits 30 seconds after one failure, doubling to at most 15 minutes', () => {
		expect(failureBackoffMs(1)).toBe(30_000);
		expect(failureBackoffMs(2)).toBe(60_000);
		expect(failureBackoffMs(4)).toBe(4 * MINUTE);
		expect(failureBackoffMs(6)).toBe(15 * MINUTE);
		expect(failureBackoffMs(50)).toBe(15 * MINUTE);
	});

	it('is retried after its back-off, not its interval, and waits longer the more it fails', () => {
		const failing = (id: string, failures: number): Candidate => ({
			...mailbox(id, true, 1),
			failuresInARow: failures
		});
		const plan = planSyncs({
			...base,
			intervalMs: 60 * MINUTE,
			slots: 4,
			candidates: [failing('once', 1), failing('often', 8), mailbox('fine', true, 1)]
		});
		expect(plan.start).toEqual(['once']);
		expect(plan.waiting.later).toBe(2);
		// The soonest of those left is the one failing often: 15 minutes after it last finished.
		expect(plan.waiting.nextDueAt).toBe(NOW - MINUTE + 15 * MINUTE);
	});
});
