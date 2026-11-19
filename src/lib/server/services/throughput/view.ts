import type { EngineStatus } from '../../../domain/engine.ts';
import type { ThroughputView } from '../../../domain/throughput.ts';
import { sharedGovernor } from '../graph/governor.ts';
import { throughputExtras } from './extras.ts';

/**
 * Everything about speed at this moment, for GET /api/throughput and the dashboard's Speed
 * block: the governor's pace, lanes, rates and recent changes, and the service's counts. It
 * names no mailbox, person or message (lanes are numbers), so it is safe to read and keep.
 */
export function throughputView(status: EngineStatus, now = Date.now()): ThroughputView {
	const governor = sharedGovernor();
	return {
		at: new Date(now).toISOString(),
		...governor.snapshot(),
		service: throughputExtras(status),
		headroom: governor.headroom()
	};
}
