import type { AppDatabase } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import { recordActivity } from '../activity/activity.ts';
import { listSnapshots, takeSnapshot } from '../storage/index-snapshot.ts';
import { formatBytes } from '../../../utils/format.ts';

/**
 * The engine's daily copy of the index onto the backup drive (storage/index-snapshot.ts).
 * A failure is an error in the activity log, so it shows under Recent problems and is emailed
 * to anyone who asked for index alerts; the engine tries again an hour later.
 */

/** When the newest snapshot was taken, or null when there is none (or the folder is unreadable). */
export function newestSnapshotAt(backupRoot: string): number | null {
	try {
		return listSnapshots(backupRoot)[0]?.takenAt ?? null;
	} catch (error) {
		serverLog('warn', 'snapshot', `Could not list the index snapshots: ${errorText(error)}`);
		return null;
	}
}

/** Takes today's snapshot. Returns when it was taken, or null when it failed (and says why). */
export async function snapshotIndex(
	db: AppDatabase,
	backupRoot: string,
	now: number
): Promise<number | null> {
	try {
		const snapshot = await takeSnapshot(db.$client, backupRoot, now);
		serverLog(
			'info',
			'snapshot',
			`Copied the index to ${snapshot.path} (${formatBytes(snapshot.bytes)})`
		);
		return snapshot.takenAt;
	} catch (error) {
		recordActivity(db, {
			level: 'error',
			kind: 'index-snapshot',
			actor: 'system',
			summary: 'Could not copy the index to the backup drive',
			detail: `${errorText(error)}. Backups go on; Lookstow tries again in an hour. Until a copy succeeds, losing the index would lose every mailbox's folder history.`
		});
		return null;
	}
}
