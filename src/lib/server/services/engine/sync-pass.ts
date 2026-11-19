import { errorText, serverLog } from '../../log.ts';
import { recordActivity } from '../activity/activity.ts';
import {
	finishRun,
	markSyncFinished,
	markSyncStarted,
	startRun,
	type MailboxRow
} from '../mailboxes/repository.ts';
import { syncMailbox } from './mailbox-sync.ts';
import type { SyncContext } from './sync-common.ts';
import { formatBytes, plural } from '../../../utils/format.ts';

/** What one mailbox's sync left for the engine. */
export type SyncPassResult = {
	/** Stopped by Pause, the disk guard or a cancel: carry on as soon as it may. */
	stoppedEarly: boolean;
};

/**
 * One sync of one mailbox (or online archive): the run record, the log lines and the activity
 * entries around syncMailbox. A failure is recorded on the mailbox, once in the activity log
 * while it keeps failing the same way, and every time in the log.
 */
export async function syncOneMailbox(
	context: SyncContext,
	mailbox: MailboxRow
): Promise<SyncPassResult> {
	const { db, now } = context;
	// An archive has its owner's address: say which one it is.
	const name = mailbox.kind === 'archive' ? `${mailbox.address} (online archive)` : mailbox.address;
	const runId = startRun(db, 'sync', mailbox.id, now());
	markSyncStarted(db, mailbox.id, now());
	const started = now();
	serverLog('info', 'sync', `${name}: ${mailbox.firstCopyDone ? 'sync' : 'first copy'} started`);
	try {
		const outcome = await syncMailbox(context, mailbox);
		markSyncFinished(db, mailbox.id, now(), {
			error: null,
			firstCopyDone: outcome.firstCopyDone || mailbox.firstCopyDone
		});
		finishRun(
			db,
			runId,
			{
				outcome: 'ok',
				added: outcome.added,
				removed: outcome.removed,
				byteCount: outcome.byteCount,
				error: null
			},
			now()
		);
		serverLog(
			'info',
			'sync',
			`${name}: ${outcome.stoppedEarly ? 'stopped after a page' : 'done'} in ${Math.round((now() - started) / 1000)} s, ${plural(outcome.added, 'message')} stored (${formatBytes(outcome.byteCount)}), ${outcome.removed} deleted at the source`
		);
		if (!mailbox.firstCopyDone && outcome.firstCopyDone) {
			recordActivity(db, {
				level: 'info',
				kind: 'first-copy',
				actor: 'system',
				summary: `First full copy of ${name} finished`,
				mailboxId: mailbox.id
			});
		}
		if (mailbox.lastSyncError !== null) {
			recordActivity(db, {
				level: 'info',
				kind: 'sync',
				actor: 'system',
				summary: `${name} syncs again`,
				mailboxId: mailbox.id
			});
		}
		return { stoppedEarly: outcome.stoppedEarly };
	} catch (error) {
		const message = errorText(error);
		markSyncFinished(db, mailbox.id, now(), {
			error: message,
			firstCopyDone: mailbox.firstCopyDone
		});
		finishRun(
			db,
			runId,
			{ outcome: 'failed', added: 0, removed: 0, byteCount: 0, error: message },
			now()
		);
		// One entry when a mailbox starts failing, not one every sync.
		if (mailbox.lastSyncError !== message) {
			recordActivity(db, {
				level: 'error',
				kind: 'sync',
				actor: 'system',
				summary: `Sync of ${name} failed`,
				detail: message,
				mailboxId: mailbox.id
			});
		} else {
			// Activity keeps one entry; the log still shows every attempt, so a start line
			// is never left without its end.
			serverLog(
				'warn',
				'sync',
				`${name}: failed again in ${Math.round((now() - started) / 1000)} s (${message})`
			);
		}
		return { stoppedEarly: false };
	}
}
