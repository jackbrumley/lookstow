import type { Actions, PageServerLoad } from './$types';
import { done } from '#lib/server/actions.ts';
import { backupEngine, database } from '#lib/server/runtime.ts';
import { listActivity, recordActivity } from '#lib/server/services/activity/activity.ts';
import { recentRuns } from '#lib/server/services/mailboxes/repository.ts';
import { mailboxSummaries, mailboxTotals } from '#lib/server/services/mailboxes/views.ts';
import { readConnection } from '#lib/server/services/settings/settings.ts';
import { LIVE_STATUS } from '#lib/domain/live-status.ts';

/** The dashboard: is everything backed up, what is running, and what needs someone. */
export const load = (async ({ parent, depends }) => {
	depends(LIVE_STATUS);
	// Syncing comes from the frame's live status, so the tiles and Now never disagree.
	const { live } = await parent();
	const syncing = new Set(live.engine.syncing.map((sync) => sync.mailboxId));
	const summaries = mailboxSummaries(database, (id) => syncing.has(id));
	const connection = readConnection(database);
	return {
		totals: mailboxTotals(summaries),
		needsAttention: summaries.filter((mailbox) => mailbox.state === 'failed').slice(0, 20),
		setup: {
			ids: connection.tenantId !== '' && connection.clientId !== '',
			credential: connection.auth.kind !== 'none',
			discovered: summaries.length > 0
		},
		lastDiscovery: recentRuns(database, { limit: 1, kind: 'discovery' })[0] ?? null,
		problems: listActivity(database, { limit: 8, level: 'error' })
	};
}) satisfies PageServerLoad;

export const actions = {
	discover: () => {
		backupEngine().requestDiscovery();
		recordActivity(database, {
			level: 'info',
			kind: 'discovery',
			actor: 'console',
			summary: 'Discover now was asked for'
		});
		return done('Looking for mailboxes now. New ones start their first copy straight after.');
	},
	syncAll: () => {
		backupEngine().requestSync(null);
		recordActivity(database, {
			level: 'info',
			kind: 'sync',
			actor: 'console',
			summary: 'Sync all now was asked for'
		});
		return done('A sync of every mailbox has started.');
	}
} satisfies Actions;
