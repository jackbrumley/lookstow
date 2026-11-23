import type { Actions, PageServerLoad } from './$types';
import { done, field, refused } from '#lib/server/actions.ts';
import { checkAgainNow } from '#lib/server/check-again.ts';
import { mailboxById } from '#lib/server/services/mailboxes/repository.ts';
import { backupEngine, database } from '#lib/server/runtime.ts';
import { listActivity, recordActivity } from '#lib/server/services/activity/activity.ts';
import { firstCopyProgress, recentRuns } from '#lib/server/services/mailboxes/repository.ts';
import { mailboxSummaries } from '#lib/server/services/mailboxes/views.ts';
import { dashboardOverview, splitProblems } from '#lib/domain/dashboard.ts';
import { readConnection, readRemote } from '#lib/server/services/settings/settings.ts';
import { LIVE_STATUS } from '#lib/domain/live-status.ts';

/** The dashboard: is everything backed up, what is running, and what needs someone. */
export const load = (async ({ parent, depends, locals }) => {
	depends(LIVE_STATUS);
	// Syncing comes from the frame's live status, so the tiles and Now never disagree.
	const { live } = await parent();
	const syncing = new Set(live.engine.syncing.map((sync) => sync.mailboxId));
	const summaries = mailboxSummaries(database, (id) => syncing.has(id), Date.parse(live.at));
	const connection = readConnection(database);
	const overview = dashboardOverview(summaries, firstCopyProgress(database));
	return {
		overview,
		problems: splitProblems(
			listActivity(database, { limit: 8, level: 'error' }),
			overview.attention
		),
		// Which syncing mailboxes are online archives, so Now can tell a mailbox from its archive.
		archives: summaries
			.filter((mailbox) => mailbox.kind === 'archive' && syncing.has(mailbox.id))
			.map((mailbox) => mailbox.id),
		completeness: {
			checking: summaries.filter((mailbox) => mailbox.completeness === 'checking').length
		},
		setup: {
			ids: connection.tenantId !== '' && connection.clientId !== '',
			credential: connection.auth.kind !== 'none',
			discovered: summaries.length > 0
		},
		lastDiscovery: recentRuns(database, { limit: 1, kind: 'discovery' })[0] ?? null,
		remoteAccess: locals.isLocal ? remoteAccessNote() : null
	};
}) satisfies PageServerLoad;

/**
 * Remote access while it is on, for a reminder on the dashboard (only on this computer): turned
 * on once, it is easy to forget.
 */
function remoteAccessNote(): { accounts: number; allowed: number } | null {
	const remote = readRemote(database);
	if (!remote.enabled) return null;
	return {
		accounts: remote.accounts.filter((account) => !account.disabled).length,
		allowed: remote.allowList.length
	};
}

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
		return done('A sync of every mailbox, online archives included, has started.');
	},
	recheck: async ({ request }) => {
		const id = field(await request.formData(), 'mailboxId');
		const mailbox = mailboxById(database, id);
		if (mailbox === undefined) return refused('No such mailbox', 404);
		return checkAgainNow(mailbox);
	}
} satisfies Actions;
