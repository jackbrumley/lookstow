import type { PageServerLoad } from './$types';
import { database } from '#lib/server/runtime.ts';
import { listActivity } from '#lib/server/services/activity/activity.ts';
import { recentRuns } from '#lib/server/services/mailboxes/repository.ts';
import type { ActivityLevel } from '#lib/domain/activity.ts';

const PAGE = 200;

/** The activity log, newest first; `?level=error` shows only problems. */
export const load = (({ url }) => {
	const level = url.searchParams.get('level');
	const filter: ActivityLevel | undefined =
		level === 'error' || level === 'warn' || level === 'info' ? level : undefined;
	return {
		level: filter ?? 'all',
		entries: listActivity(database, {
			limit: PAGE,
			...(filter === undefined ? {} : { level: filter })
		}),
		discoveries: recentRuns(database, { limit: 10, kind: 'discovery' })
	};
}) satisfies PageServerLoad;
