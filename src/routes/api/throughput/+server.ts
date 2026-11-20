import type { RequestHandler } from './$types';
import { backupEngine } from '#lib/server/runtime.ts';
import { slowQueries } from '#lib/server/database/slow-queries.ts';
import { threadHealth } from '#lib/server/work/thread-health.ts';

/**
 * GET /api/throughput: how fast Lookstow is copying, and why not faster (the throughput
 * governor's pace, lanes, rates and recent changes), plus how each thread is coping: how long it
 * was held in the last minute and the slow queries it ran (docs/specs/SPEC-SCALE.md). Read-only,
 * answered only on this computer like every console page, and free of addresses, names and ids
 * (queries are shown with their values left out).
 */
export const GET: RequestHandler = () => {
	const work = backupEngine().snapshot();
	return Response.json(
		{
			...work.live.speed,
			threads: {
				web: { held: threadHealth(), slowQueries: slowQueries() },
				work: { held: work.health, slowQueries: work.slowQueries }
			}
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
