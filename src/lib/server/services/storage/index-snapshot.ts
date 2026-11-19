import type Database from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Daily copies of the index (lookstow.db) on the backup drive, so losing or corrupting the
 * index costs at most a day of history instead of every mailbox's history and a full copy
 * again. SQLite's online backup copies a consistent database while syncs keep writing. Only
 * the newest SNAPSHOTS_KEPT are kept; nothing else in the backup root is ever touched.
 * Restoring is a manual step (README, "If the index is lost"): the database is never replaced
 * automatically.
 */

/** Inside the backup root, beside the mailbox folders. */
export const SNAPSHOT_FOLDER = '.lookstow-index';
export const SNAPSHOTS_KEPT = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_NAME = /^lookstow-\d{4}-\d{2}-\d{2}\.db$/;
const PARTIAL_NAME = /^lookstow-\d{4}-\d{2}-\d{2}\.db\.partial$/;

export type Snapshot = { name: string; path: string; takenAt: number; bytes: number };

export function snapshotFolder(backupRoot: string): string {
	return join(backupRoot, SNAPSHOT_FOLDER);
}

/** The snapshots in the backup root, newest first. None when the folder does not exist yet. */
export function listSnapshots(backupRoot: string): Snapshot[] {
	const folder = snapshotFolder(backupRoot);
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	return names
		.filter((name) => SNAPSHOT_NAME.test(name))
		.map((name) => {
			const path = join(folder, name);
			const stats = statSync(path);
			return { name, path, takenAt: stats.mtimeMs, bytes: stats.size };
		})
		.sort((a, b) => b.name.localeCompare(a.name));
}

/** Whether the newest snapshot is more than a day old (or there is none). */
export function snapshotDue(newestAt: number | null, now: number): boolean {
	return newestAt === null || now - newestAt >= DAY_MS;
}

/**
 * Copies the index to `lookstow-<yyyy-mm-dd>.db` (UTC) through a `.partial` file, so a stopped
 * copy never looks finished, then keeps the newest SNAPSHOTS_KEPT. A second snapshot on the
 * same day replaces that day's.
 */
export async function takeSnapshot(
	client: Database.Database,
	backupRoot: string,
	now: number
): Promise<Snapshot> {
	const folder = snapshotFolder(backupRoot);
	mkdirSync(folder, { recursive: true });
	const name = `lookstow-${new Date(now).toISOString().slice(0, 10)}.db`;
	const path = join(folder, name);
	const partial = `${path}.partial`;
	await rm(partial, { force: true });
	await client.backup(partial);
	await rename(partial, path);
	await pruneSnapshots(backupRoot);
	const stats = statSync(path);
	return { name, path, takenAt: stats.mtimeMs, bytes: stats.size };
}

/** Deletes snapshots beyond the newest SNAPSHOTS_KEPT, and partial copies a stop left behind. */
async function pruneSnapshots(backupRoot: string): Promise<void> {
	const folder = snapshotFolder(backupRoot);
	for (const old of listSnapshots(backupRoot).slice(SNAPSHOTS_KEPT)) {
		await rm(old.path);
	}
	for (const name of readdirSync(folder).filter((entry) => PARTIAL_NAME.test(entry))) {
		await rm(join(folder, name), { force: true });
	}
}

/**
 * Whether the snapshots share a drive with the index: they then survive a corrupted index but
 * not the loss of that drive. `unknown` when either folder cannot be read yet.
 */
export function snapshotDrive(
	backupRoot: string,
	dataDir: string
): 'same' | 'different' | 'unknown' {
	try {
		return statSync(backupRoot).dev === statSync(dataDir).dev ? 'same' : 'different';
	} catch {
		return 'unknown';
	}
}

/** What Settings shows about the snapshots. */
export type SnapshotSummary =
	| {
			kind: 'listed';
			folder: string;
			newest: { takenAt: string; bytes: number } | null;
			kept: number;
			drive: 'same' | 'different' | 'unknown';
	  }
	| { kind: 'unreadable'; folder: string; reason: string };

export function snapshotSummary(backupRoot: string, dataDir: string): SnapshotSummary {
	const folder = snapshotFolder(backupRoot);
	try {
		const snapshots = listSnapshots(backupRoot);
		const newest = snapshots[0];
		return {
			kind: 'listed',
			folder,
			newest:
				newest === undefined
					? null
					: { takenAt: new Date(newest.takenAt).toISOString(), bytes: newest.bytes },
			kept: snapshots.length,
			drive: snapshotDrive(backupRoot, dataDir)
		};
	} catch (error) {
		return {
			kind: 'unreadable',
			folder,
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}
