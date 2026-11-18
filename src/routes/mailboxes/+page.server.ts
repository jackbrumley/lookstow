import type { PageServerLoad } from './$types';
import { backupEngine, database } from '#lib/server/runtime.ts';
import { mailboxSummaries } from '#lib/server/services/mailboxes/views.ts';

/** Every mailbox discovery has found, with its state. Filtering happens on the page. */
export const load = (() => {
	const engine = backupEngine();
	return { mailboxes: mailboxSummaries(database, (id) => engine.isSyncing(id)) };
}) satisfies PageServerLoad;
