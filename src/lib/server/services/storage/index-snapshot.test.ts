import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { activity } from '../../database/schema.ts';
import { listActivity, recordActivity } from '../activity/activity.ts';
import { alertFor } from '../alerts/alert-rules.ts';
import { snapshotIndex } from '../engine/snapshot-task.ts';
import {
	listSnapshots,
	snapshotDue,
	snapshotFolder,
	SNAPSHOTS_KEPT,
	takeSnapshot
} from './index-snapshot.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 19, 12);

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'lookstow-snapshot-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function indexWithRows() {
	const db = openDatabase(join(dir, 'data', 'lookstow.db'));
	for (const summary of ['one', 'two', 'three']) {
		recordActivity(db, { level: 'info', kind: 'test', actor: 'system', summary });
	}
	return db;
}

describe('index snapshots', () => {
	it('a snapshot is a complete, consistent copy', async () => {
		const db = indexWithRows();
		const root = join(dir, 'backup');
		const snapshot = await takeSnapshot(db.$client, root, NOW);
		expect(snapshot.name).toBe('lookstow-2026-11-19.db');
		const copy = new Database(snapshot.path, { readonly: true });
		const count: unknown = copy.prepare('select count(*) as n from activity').get();
		copy.close();
		expect(count).toEqual({ n: db.select().from(activity).all().length });
		db.$client.close();
	});

	it('keeps seven and touches nothing else', async () => {
		const db = indexWithRows();
		const root = join(dir, 'backup');
		const folder = snapshotFolder(root);
		await mkdir(folder, { recursive: true });
		for (let day = 1; day <= 9; day++) {
			await writeFile(join(folder, `lookstow-2026-10-${String(day).padStart(2, '0')}.db`), 'old');
		}
		await writeFile(join(folder, 'notes.txt'), 'kept');
		await mkdir(join(root, 'ann@example.com', '2026', '11'), { recursive: true });
		await writeFile(join(root, 'ann@example.com', '2026', '11', 'a.eml'), 'mail');
		await takeSnapshot(db.$client, root, NOW);
		const kept = listSnapshots(root).map((snapshot) => snapshot.name);
		expect(kept).toHaveLength(SNAPSHOTS_KEPT);
		expect(kept[0]).toBe('lookstow-2026-11-19.db');
		expect(kept.at(-1)).toBe('lookstow-2026-10-04.db');
		expect(existsSync(join(folder, 'notes.txt'))).toBe(true);
		expect(existsSync(join(root, 'ann@example.com', '2026', '11', 'a.eml'))).toBe(true);
		db.$client.close();
	});

	it('a stopped snapshot never looks finished, and is cleared by the next one', async () => {
		const db = indexWithRows();
		const root = join(dir, 'backup');
		const folder = snapshotFolder(root);
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, 'lookstow-2026-11-18.db.partial'), 'half');
		expect(listSnapshots(root)).toEqual([]);
		await takeSnapshot(db.$client, root, NOW);
		expect(readdirSync(folder)).toEqual(['lookstow-2026-11-19.db']);
		db.$client.close();
	});

	it('is due once a day', () => {
		expect(snapshotDue(null, NOW)).toBe(true);
		expect(snapshotDue(NOW - DAY + 1, NOW)).toBe(false);
		expect(snapshotDue(NOW - DAY, NOW)).toBe(true);
	});

	it('a failed snapshot is reported as an error, and alerts', async () => {
		const db = indexWithRows();
		// A file where the backup root should be: the snapshot folder cannot be made.
		const root = join(dir, 'not-a-folder');
		await writeFile(root, 'x');
		expect(await snapshotIndex(db, root, NOW)).toBeNull();
		const [entry] = listActivity(db, { limit: 1, level: 'error' });
		expect(entry).toMatchObject({ kind: 'index-snapshot' });
		if (entry === undefined) throw new Error('no entry');
		expect(alertFor(entry)?.alert).toBe('index-snapshot');
		db.$client.close();
	});
});
