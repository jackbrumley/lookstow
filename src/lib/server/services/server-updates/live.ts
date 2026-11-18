import { env } from '../../env.ts';
import { errorText, serverLog } from '../../log.ts';
import { database } from '../../runtime.ts';
import { recordActivity } from '../activity/activity.ts';
import { makeServerUpdates, type ServerUpdates } from './service.ts';

/**
 * The one update service of this process. Kept on globalThis under a registered symbol, so a
 * module loaded twice (Vite's dev server reloading it) still finds the same service and timer.
 */
const KEY = Symbol.for('lookstow.server-updates');
const TIMER_KEY = Symbol.for('lookstow.server-update-timer');

function isService(value: unknown): value is ServerUpdates {
	return (
		typeof value === 'object' &&
		value !== null &&
		'view' in value &&
		typeof value.view === 'function' &&
		'check' in value &&
		typeof value.check === 'function'
	);
}

export function serverUpdates(): ServerUpdates {
	const held: unknown = Reflect.get(globalThis, KEY);
	if (isService(held)) return held;
	const created = makeServerUpdates(env.launcher, (entry) => {
		recordActivity(database, entry);
	});
	Reflect.set(globalThis, KEY, created);
	return created;
}

/**
 * Checks for a new release now if one is due, then every minute whether the daily check is due.
 * Called once from the server's `init` hook; later calls do nothing.
 */
export function startUpdateChecks(): void {
	if (Reflect.get(globalThis, TIMER_KEY) === true) return;
	Reflect.set(globalThis, TIMER_KEY, true);
	const check = (): void => {
		if (serverUpdates().due(Date.now()))
			void serverUpdates()
				.check('schedule', Date.now())
				.catch((error: unknown) => {
					serverLog('warn', 'updates', `Update check failed: ${errorText(error)}`);
				});
	};
	check();
	const timer = setInterval(check, 60_000);
	timer.unref();
}
