import { MIGRATIONS_FOLDER } from '#lib/server/database/connection.ts';
import { databaseReadiness } from '#lib/server/database/readiness.ts';
import { serverLog } from '#lib/server/log.ts';
import { database } from '#lib/server/runtime.ts';
import { APP_VERSION } from '#lib/utils/app-version.ts';
import type { RequestHandler } from './$types';

/**
 * GET /readyz: the database answers and every migration is applied. The installers wait on it
 * before printing the console's address. The reason for a 503 goes to the log, not the caller.
 */
export const GET: RequestHandler = () => {
	const readiness = databaseReadiness(database.$client, MIGRATIONS_FOLDER);
	const headers = { 'cache-control': 'no-store' };
	switch (readiness.kind) {
		case 'ready':
			return Response.json({ status: 'ready', version: APP_VERSION }, { headers });
		case 'not-ready':
			serverLog('warn', 'database', `GET /readyz: not ready (${readiness.reason})`);
			return Response.json({ status: 'not-ready' }, { status: 503, headers });
	}
};
