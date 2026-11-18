import type { RequestHandler } from './$types';
import { logSince } from '#lib/server/log.ts';

/** GET /api/log?after=<seq>: the service log lines after that number, for the Log page. */
export const GET: RequestHandler = ({ url }) => {
	const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10);
	return Response.json(
		{ lines: logSince(Number.isFinite(after) ? after : 0) },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
