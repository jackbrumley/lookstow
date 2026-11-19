import { describe, expect, it } from 'vitest';
import type { EngineStatus } from '../../../domain/engine.ts';
import { isBusy, phaseText, statusContradictions } from '../../../domain/live-status.ts';
import { liveStatus } from './live-status.ts';

function idle(): EngineStatus {
	return {
		pause: { paused: false },
		problem: null,
		discovery: { running: false, progress: null, lastAt: null, nextAt: null },
		syncing: [],
		waiting: { requested: 0, due: 0, firstCopy: 0, later: 3, nextDueAt: null },
		slots: { current: 1, maximum: 8 },
		failing: {},
		rates: {
			lastMinute: { bytesPerSecond: 0, messagesPerSecond: 0 },
			last15Minutes: { bytesPerSecond: 0, messagesPerSecond: 0 }
		},
		throttled: { lastMinute: 0, last15Minutes: 0 },
		disk: {
			path: '/backup',
			usedPercent: 50,
			freeBytes: 1,
			totalBytes: 2,
			level: 'ok',
			warnPercent: 85,
			pausePercent: 90
		},
		relayout: null,
		indexSnapshot: { running: false, lastAt: null },
		backupMove: { kind: 'none' }
	};
}

function syncing(): EngineStatus {
	return {
		...idle(),
		syncing: [
			{
				mailboxId: 'm1',
				address: 'ann@example.com',
				folder: 'Inbox',
				stored: 1,
				bytes: 10,
				startedAt: new Date(0).toISOString(),
				firstCopy: true
			}
		]
	};
}

const states: [string, () => EngineStatus, string][] = [
	['idle', idle, 'Idle'],
	['syncing', syncing, 'Backing up 1 mailbox'],
	[
		'paused while a sync finishes its page',
		() => ({
			...syncing(),
			pause: { paused: true, reason: 'manual', since: null }
		}),
		'Paused'
	],
	[
		'finding mailboxes',
		() => ({
			...idle(),
			discovery: { running: true, progress: null, lastAt: null, nextAt: null }
		}),
		'Finding mailboxes'
	],
	[
		'moving files into the date layout',
		() => ({
			...idle(),
			relayout: { moved: 1, total: 2, problems: 0 }
		}),
		'Idle'
	]
];

describe('the one live status', () => {
	it.each(states)('is consistent and says what runs: %s', (_name, status, text) => {
		const live = liveStatus({ status }, 0);
		expect(statusContradictions(live)).toEqual([]);
		expect(phaseText(live)).toBe(text);
		expect(live.speed.service.engine.mailboxesSyncing).toBe(live.engine.syncing.length);
	});

	it('is busy only while a sync or discovery runs', () => {
		expect(isBusy(liveStatus({ status: idle }, 0))).toBe(false);
		expect(isBusy(liveStatus({ status: syncing }, 0))).toBe(true);
	});

	it('names every combination that must never show', () => {
		const live = liveStatus({ status: syncing }, 0);
		const broken = {
			...live,
			engine: {
				...live.engine,
				syncing: [...live.engine.syncing, ...live.engine.syncing],
				slots: { current: 9, maximum: 8 },
				relayout: { moved: 0, total: 1, problems: 0 },
				discovery: { running: true, progress: null, lastAt: null, nextAt: '2026-01-01T00:00:00Z' }
			}
		};
		expect(statusContradictions(broken)).toEqual([
			'A mailbox is listed as syncing twice',
			'The Speed card counts 1 mailboxes syncing; the engine runs 2',
			'9 mailboxes at once is above the limit of 8',
			'A sync runs while files move into the date layout',
			'Discovery is running and also shows its next time'
		]);
		const idlePace = {
			...live,
			speed: { ...live.speed, pace: { ...live.speed.pace, phase: 'idle' as const, inFlight: 2 } }
		};
		expect(statusContradictions(idlePace)).toContain(
			'The pace says idle while requests are in flight'
		);
	});
});
