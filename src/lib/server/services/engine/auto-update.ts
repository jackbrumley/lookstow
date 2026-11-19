import type { Queryable } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import type { ServerUpdates } from '../server-updates/service.ts';
import { readBackupMove, readUpdates } from '../settings/settings.ts';

/**
 * Automatic updates (Settings > Updates, on by default): when the daily check has found a newer
 * signed release and nothing is under way, ask the root updater for it, exactly as Update now
 * does. The updater still verifies the signature and rolls back a release that does not start.
 */
const EVERY_MS = 10 * 60 * 1000;
const QUIET_PHASES = new Set(['idle', 'up-to-date', 'healthy']);

export function startAutomaticUpdates(db: Queryable, updates: () => ServerUpdates): void {
	const tick = (): void => {
		try {
			const version = automaticUpdateDue(db, updates());
			if (version !== null) {
				updates().request(version, Date.now(), 'system');
				serverLog('info', 'updates', `Installing Lookstow ${version} automatically`);
			}
		} catch (error) {
			serverLog('warn', 'updates', `Automatic update not started: ${errorText(error)}`);
		}
	};
	const timer = setInterval(tick, EVERY_MS);
	timer.unref();
}

/** The version to install now, or null. A failed or rolled-back update is not retried by itself. */
export function automaticUpdateDue(
	db: Queryable,
	updates: Pick<ServerUpdates, 'view'>
): string | null {
	// Not while the backup folder moves: the move is finished first.
	if (!readUpdates(db).automatic || readBackupMove(db).kind === 'moving') {
		return null;
	}
	const view = updates.view();
	if (view.release === null || !view.install.allowed || !QUIET_PHASES.has(view.operation.phase)) {
		return null;
	}
	return view.release.version;
}
