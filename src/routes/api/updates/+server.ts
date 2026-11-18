import { consoleWrite } from '#lib/server/services/server-updates/guards.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

/** The Updates page: this version, the latest release on offer and the updater's progress. */
export const GET: RequestHandler = () =>
	Response.json(serverUpdates().view(), { headers: NO_STORE });

/** Check now: asks GitHub for the latest release, then replies like GET. */
export const POST: RequestHandler = async ({ request, url }) => {
	const allowed = consoleWrite(request, url);
	if (allowed.kind === 'refused') {
		return Response.json({ message: allowed.reason }, { status: 403, headers: NO_STORE });
	}
	await serverUpdates().check('console', Date.now());
	return Response.json(serverUpdates().view(), { headers: NO_STORE });
};
