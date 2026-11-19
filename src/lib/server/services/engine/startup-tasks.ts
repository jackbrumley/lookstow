import type { Queryable } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import { recordActivity } from '../activity/activity.ts';
import { indexArchiveItems } from '../fts/fts-index.ts';
import { closeInterruptedRuns, recountStoredMessages } from '../mailboxes/repository.ts';
import { refileArchiveItems, relayoutFiles, type RelayoutProgress } from '../storage/relayout.ts';
import { plural } from '../../../utils/format.ts';

/**
 * The work the engine does once at start-up, before or beside the first syncs: close the runs
 * the last stop cut short, correct message counts, move old files into the date layout, and
 * read archive items stored before Lookstow could read them. Each is a no-op when there is
 * nothing to do, and each is safe to stop and run again at the next start.
 */

/** Closes runs the last stop cut short, and corrects counts from the stored messages. */
export function closeLastStop(db: Queryable, now: number): void {
	const interrupted = closeInterruptedRuns(db, now);
	if (interrupted > 0) {
		recordActivity(db, {
			level: 'warn',
			kind: 'engine',
			actor: 'system',
			summary: `${interrupted} run${interrupted === 1 ? ' was' : 's were'} interrupted by the last stop`
		});
	}
	const recounted = recountStoredMessages(db);
	if (recounted > 0) {
		recordActivity(db, {
			level: 'info',
			kind: 'engine',
			actor: 'system',
			summary: `Corrected the message count of ${plural(recounted, 'mailbox', 'mailboxes')} from the stored messages`
		});
	}
}

/** Moves files stored before 0.4.0 into the date layout. Syncs wait until it is done. */
export async function moveToDateLayout(
	db: Queryable,
	backupRoot: string,
	stopping: () => boolean,
	progress: (progress: RelayoutProgress) => void
): Promise<void> {
	try {
		const outcome = await relayoutFiles(db, backupRoot, {
			stopping,
			progress,
			problem: (message) => {
				serverLog('warn', 'storage', `Moving to the date layout: ${message}`);
			}
		});
		if (outcome.total === 0) return;
		serverLog(
			'info',
			'storage',
			`Moved ${outcome.moved} of ${outcome.total} message files to the date layout${outcome.stopped ? ' (stopped; carries on at the next start)' : ''}`
		);
		if (!outcome.stopped) {
			recordActivity(db, {
				level: outcome.problems === 0 ? 'info' : 'warn',
				kind: 'engine',
				actor: 'system',
				summary: `${outcome.moved} message files stored before 0.4.0 were moved into the date layout (mailbox/year/month)`,
				detail:
					outcome.problems === 0
						? null
						: `${outcome.problems} could not be moved; see the Log. They keep their old paths and still open from Search.`
			});
		}
	} catch (error) {
		serverLog('error', 'storage', `Moving files to the date layout failed: ${errorText(error)}`);
	}
}

/**
 * Reads archive items stored before 0.6.0 for Search, then files each one under the month it
 * was received. Only reads and renames files, so syncs go on meanwhile.
 */
export async function readOlderArchiveItems(
	db: Queryable,
	backupRoot: string,
	stopping: () => boolean
): Promise<void> {
	try {
		const outcome = await indexArchiveItems(db, backupRoot, stopping);
		if (outcome.stopped) return;
		if (outcome.total > 0) {
			recordActivity(db, {
				level: outcome.problems === 0 ? 'info' : 'warn',
				kind: 'engine',
				actor: 'system',
				summary: `${String(outcome.indexed)} online archive items stored earlier can now be found in Search`,
				detail:
					outcome.problems === 0
						? null
						: `${String(outcome.problems)} could not be read; see the Log. Their files are kept as they are.`
			});
		}
		const refiled = await refileArchiveItems(db, backupRoot, {
			stopping,
			progress: () => undefined,
			problem: (message) => {
				serverLog('warn', 'storage', `Filing an archive item by its received date: ${message}`);
			}
		});
		if (refiled.total > 0 && !refiled.stopped) {
			recordActivity(db, {
				level: refiled.problems === 0 ? 'info' : 'warn',
				kind: 'engine',
				actor: 'system',
				summary: `${String(refiled.moved)} online archive items were filed under the month they were received`,
				detail:
					refiled.problems === 0
						? null
						: `${String(refiled.problems)} could not be moved; see the Log. They keep their place and still open from Search.`
			});
		}
	} catch (error) {
		serverLog('error', 'archive', `Reading archive items for Search failed: ${errorText(error)}`);
	}
}
