import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineStatus } from '../../../domain/engine.ts';
import { openDatabase } from '../../database/connection.ts';
import { Governor } from '../graph/governor.ts';
import { readLearnedPace, saveLearnedPace } from '../settings/settings.ts';
import { throughputExtras } from './extras.ts';
import { historyFileName, historyLine, pruneHistory } from './monitor.ts';

const ADDRESS = 'jason.shaw@example.com';
const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GRAPH_ID = 'AAMkAGI2TG93AAA=';

/** An engine status naming a mailbox, a folder and an id, as the real one does. */
function status(): EngineStatus {
	return {
		pause: { paused: false },
		problem: null,
		discovery: { running: false, progress: null, lastAt: null, nextAt: null },
		syncing: [
			{
				mailboxId: GUID,
				address: ADDRESS,
				folder: `Inbox/${GRAPH_ID}`,
				stored: 12,
				bytes: 3000,
				startedAt: new Date(0).toISOString(),
				firstCopy: true
			}
		],
		waiting: { requested: 1, due: 2, firstCopy: 3, later: 4, nextDueAt: null },
		slots: { current: 6, maximum: 8 },
		rates: {
			lastMinute: { bytesPerSecond: 100, messagesPerSecond: 1 },
			last15Minutes: { bytesPerSecond: 50, messagesPerSecond: 0.5 }
		},
		throttled: { lastMinute: 0, last15Minutes: 0 },
		disk: {
			path: 'C:\\ProgramData\\Lookstow\\mailboxes',
			usedPercent: 58,
			freeBytes: 1,
			totalBytes: 2,
			level: 'ok',
			warnPercent: 85,
			pausePercent: 90
		},
		relayout: null,
		indexSnapshot: { running: false, lastAt: null }
	} as const satisfies EngineStatus;
}

const PRIVATE = [/@/, /[0-9a-f]{8}-[0-9a-f]{4}-/i, /AAMk/, /ProgramData/];

describe('the throughput monitor', () => {
	it('keeps no address, GUID, Graph id or path in what it shows or writes', async () => {
		const governor = new Governor({ now: () => 0 });
		(await governor.acquire(GUID)).release({ kind: 'ok', bytes: 10, pressure: false });
		const extras = throughputExtras(status());
		expect(extras.engine).toMatchObject({ mailboxesSyncing: 1, firstCopiesSyncing: 1 });
		const line = JSON.stringify(historyLine(governor.snapshot(), { service: extras }, 0));
		for (const pattern of PRIVATE) expect(line).not.toMatch(pattern);
	});

	it('keeps seven days of history files and deletes older ones', async () => {
		const folder = await mkdtemp(join(tmpdir(), 'lookstow-pace-'));
		const now = Date.parse('2026-11-19T12:00:00Z');
		const day = 24 * 60 * 60_000;
		for (const age of [0, 6, 7, 8, 30]) {
			await writeFile(join(folder, historyFileName(now - age * day)), '{}\n');
		}
		await writeFile(join(folder, 'notes.txt'), 'kept');
		await pruneHistory(folder, now);
		expect((await readdir(folder)).sort()).toEqual([
			'2026-11-12.jsonl',
			'2026-11-13.jsonl',
			'2026-11-19.jsonl',
			'notes.txt'
		]);
	});

	it('keeps what the governor learned between restarts, and forgets it on request', () => {
		const db = openDatabase(':memory:');
		expect(readLearnedPace(db)).toBeNull();
		const learned = {
			startsPerSecond: 42.5,
			inFlightCap: 60,
			ceiling: { startsPerSecond: 50, inFlightCap: 70, at: 1 }
		};
		saveLearnedPace(db, learned);
		const restarted = new Governor({ now: () => 0, learned: readLearnedPace(db) });
		expect(restarted.learned()).toEqual(learned);
		restarted.forget();
		saveLearnedPace(db, restarted.learned());
		expect(readLearnedPace(db)?.ceiling).toBeNull();
	});
});
