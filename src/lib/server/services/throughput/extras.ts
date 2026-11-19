import type { EngineStatus } from '../../../domain/engine.ts';
import type { ThroughputService } from '../../../domain/throughput.ts';

/**
 * The service's own numbers beside the governor's, for /api/throughput and the pace history:
 * counts only. The engine's status names mailboxes and folders; none of that is copied here.
 */
export function throughputExtras(status: EngineStatus): ThroughputService {
	const memory = process.memoryUsage();
	return {
		engine: {
			paused: status.pause.paused,
			mailboxesSyncing: status.syncing.length,
			firstCopiesSyncing: status.syncing.filter((sync) => sync.firstCopy).length,
			slots: status.slots,
			waiting: {
				requested: status.waiting.requested,
				due: status.waiting.due,
				firstCopy: status.waiting.firstCopy,
				later: status.waiting.later
			},
			messagesStoredBySyncsRunning: status.syncing.reduce((sum, sync) => sum + sync.stored, 0),
			bytesStoredBySyncsRunning: status.syncing.reduce((sum, sync) => sum + sync.bytes, 0)
		},
		rates: status.rates,
		throttled: status.throttled,
		disk: { usedPercent: status.disk.usedPercent, level: status.disk.level },
		memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed }
	};
}
