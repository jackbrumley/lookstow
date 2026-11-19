import { serverLog } from '../../log.ts';
import { throughputView } from '../throughput/view.ts';
import { statusContradictions, type LiveStatus } from '../../../domain/live-status.ts';
import type { Engine } from './engine.ts';

/** Contradictions already logged, so a lasting one is logged once, not every few seconds. */
const logged = new Set<string>();

/**
 * The one live status (docs/specs/SPEC-STATUS.md): the engine's status and the governor's
 * snapshot taken together, once. The layout's load returns it to every page; nothing else in
 * the console asks the engine whether something is running.
 */
export function liveStatus(engine: Pick<Engine, 'status'>, now = Date.now()): LiveStatus {
	const status = engine.status();
	const live: LiveStatus = {
		at: new Date(now).toISOString(),
		engine: status,
		speed: throughputView(status, now)
	};
	for (const contradiction of statusContradictions(live)) {
		if (!logged.has(contradiction)) {
			logged.add(contradiction);
			serverLog('warn', 'status', `The live status contradicts itself: ${contradiction}`);
		}
	}
	return live;
}
