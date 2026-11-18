import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { done, refused } from '#lib/server/actions.ts';
import { backupEngine, database, dataDir } from '#lib/server/runtime.ts';
import { listActivity, recordActivity } from '#lib/server/services/activity/activity.ts';
import { mailboxById, setExcluded } from '#lib/server/services/mailboxes/repository.ts';
import { mailboxDetail } from '#lib/server/services/mailboxes/views.ts';
import { effectiveBackupRoot } from '#lib/server/services/settings/settings.ts';

/** One mailbox: its folders, recent syncs and activity, and the actions an admin can take. */
export const load = (({ params }) => {
	const engine = backupEngine();
	const detail = mailboxDetail(
		database,
		params.id,
		effectiveBackupRoot(database, dataDir()),
		(id) => engine.isSyncing(id)
	);
	if (detail === null) {
		error(404, 'No such mailbox');
	}
	return {
		mailbox: detail,
		activity: listActivity(database, { limit: 30, mailboxId: params.id })
	};
}) satisfies PageServerLoad;

export const actions = {
	syncNow: ({ params }) => {
		const mailbox = mailboxById(database, params.id);
		if (mailbox === undefined) {
			return refused('No such mailbox', 404);
		}
		if (mailbox.kind === 'archive') {
			return refused('Copying online archives is not built yet.');
		}
		backupEngine().requestSync([mailbox.id], 'console');
		recordActivity(database, {
			level: 'info',
			kind: 'sync',
			actor: 'console',
			summary: `Sync now was asked for ${mailbox.address}`,
			mailboxId: mailbox.id
		});
		return done(`${mailbox.address} syncs next.`);
	},
	exclude: ({ params }) => setExclusion(params.id, true),
	include: ({ params }) => setExclusion(params.id, false)
} satisfies Actions;

function setExclusion(id: string, excluded: boolean) {
	const mailbox = mailboxById(database, id);
	if (mailbox === undefined) {
		return refused('No such mailbox', 404);
	}
	setExcluded(database, id, excluded);
	recordActivity(database, {
		level: excluded ? 'warn' : 'info',
		kind: 'mailbox-scope',
		actor: 'console',
		summary: excluded
			? `${mailbox.address} was excluded: it is no longer backed up (its backup so far is kept)`
			: `${mailbox.address} is backed up again`,
		mailboxId: id
	});
	if (!excluded) {
		backupEngine().requestSync([id], 'included again');
	}
	return done(
		excluded ? `${mailbox.address} is excluded.` : `${mailbox.address} is backed up again.`
	);
}
