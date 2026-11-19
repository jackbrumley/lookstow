import type { RequestHandler } from './$types';
import { backupEngine } from '#lib/server/runtime.ts';
import { throughputView } from '#lib/server/services/throughput/view.ts';

/**
 * GET /api/throughput: how fast Lookstow is copying, and why not faster (the throughput
 * governor's pace, lanes, rates and recent changes). Read-only, answered only on this computer
 * like every console page, and free of addresses, names and ids.
 */
export const GET: RequestHandler = () =>
	Response.json(throughputView(backupEngine().status()), {
		headers: { 'cache-control': 'no-store' }
	});
