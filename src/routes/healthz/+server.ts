import type { RequestHandler } from './$types';

/**
 * GET /healthz: the process is up and serving requests. For monitoring; says nothing else.
 */
export const GET: RequestHandler = () =>
	Response.json({ status: 'alive' }, { headers: { 'cache-control': 'no-store' } });
