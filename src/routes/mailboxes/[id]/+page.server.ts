import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { done, field, refused } from '#lib/server/actions.ts';
import { backupEngine, database, dataDir } from '#lib/server/runtime.ts';
import { listActivity, recordActivity } from '#lib/server/services/activity/activity.ts';
import { resolveExistingBackup } from '#lib/server/existing-backup.ts';
import {
	mailboxById,
	setExcluded,
	setMailboxPaused
} from '#lib/server/services/mailboxes/repository.ts';
import {
	countItemFailures,
	mailboxItemFailures,
	retryItemFailures
} from '#lib/server/services/mailboxes/item-failures.ts';
import { mailboxDetail } from '#lib/server/services/mailboxes/views.ts';
import { effectiveBackupRoot, readScope } from '#lib/server/services/settings/settings.ts';
import { LIVE_STATUS } from '#lib/domain/live-status.ts';

/** One mailbox: its folders, recent syncs and activity, and the actions an admin can take. */
export const load = (async ({ params, parent, depends }) => {
	depends(LIVE_STATUS);
	const { live } = await parent();
	const syncing = new Set(live.engine.syncing.map((sync) => sync.mailboxId));
	const detail = mailboxDetail(
		database,
		params.id,
		effectiveBackupRoot(database, dataDir()),
		(id) => syncing.has(id),
		Date.parse(live.at)
	);
	if (detail === null) {
		error(404, 'No such mailbox');
	}
	return {
		mailbox: detail,
		picking: readScope(database).mode === 'selected',
		activity: listActivity(database, { limit: 30, mailboxId: params.id }),
		failures: {
			total: countItemFailures(database, params.id),
			items: mailboxItemFailures(database, params.id).map((failure) => ({
				graphId: failure.graphId,
				folderPath: failure.folderPath,
				subject: failure.subject,
				receivedAt: failure.receivedAt?.toISOString() ?? null,
				attempts: failure.attempts,
				nextTryAt: failure.nextTryAt.toISOString(),
				lastError: failure.lastError,
				terminal: failure.terminal
			}))
		}
	};
}) satisfies PageServerLoad;

function found(id: string) {
	return mailboxById(database, id);
}

export const actions = {
	retryFailures: ({ params }) => {
		const mailbox = found(params.id);
		if (mailbox === undefined) {
			return refused('No such mailbox', 404);
		}
		const items = retryItemFailures(database, mailbox.id, Date.now());
		backupEngine().requestSync([mailbox.id]);
		recordActivity(database, {
			level: 'info',
			kind: 'sync',
			actor: 'console',
			summary: `Items that could not be copied from ${mailbox.address} are tried again (${String(items)})`,
			mailboxId: mailbox.id
		});
		return done(`${String(items)} items are tried again in the next sync.`);
	},
	syncNow: ({ params }) => {
		const mailbox = found(params.id);
		if (mailbox === undefined) {
			return refused('No such mailbox', 404);
		}
		backupEngine().requestSync([mailbox.id]);
		recordActivity(database, {
			level: 'info',
			kind: 'sync',
			actor: 'console',
			summary: `Sync now was asked for ${mailbox.address}`,
			mailboxId: mailbox.id
		});
		return done(
			mailbox.paused
				? `${mailbox.address} is paused: resume it to sync.`
				: `${mailbox.address} syncs next.`
		);
	},
	pause: ({ params }) => setPaused(params.id, true),
	resume: ({ params }) => setPaused(params.id, false),
	exclude: async ({ params, request }) => {
		const mailbox = found(params.id);
		if (mailbox === undefined) {
			return refused('No such mailbox', 404);
		}
		const data = await request.formData();
		setExcluded(database, params.id, true);
		backupEngine().cancel(params.id);
		const problem = await resolveExistingBackup(params.id, data);
		if (problem !== null) {
			setExcluded(database, params.id, false);
			return refused(problem);
		}
		const deleted = field(data, 'existing') === 'delete';
		recordActivity(database, {
			level: 'warn',
			kind: 'mailbox-scope',
			actor: 'console',
			summary: `${mailbox.address} was excluded: it is no longer backed up${deleted ? '' : ' (its backup so far is kept)'}`,
			mailboxId: params.id
		});
		return done(
			deleted
				? `${mailbox.address} is excluded and its backup was deleted.`
				: `${mailbox.address} is excluded. Its backup so far is kept.`
		);
	},
	include: ({ params }) => {
		const mailbox = found(params.id);
		if (mailbox === undefined) {
			return refused('No such mailbox', 404);
		}
		setExcluded(database, params.id, false);
		backupEngine().requestSync([params.id]);
		recordActivity(database, {
			level: 'info',
			kind: 'mailbox-scope',
			actor: 'console',
			summary: `${mailbox.address} is backed up again`,
			mailboxId: params.id
		});
		return done(`${mailbox.address} is backed up again.`);
	},
	deleteBackup: async ({ params, request }) => {
		const mailbox = found(params.id);
		if (mailbox === undefined) {
			return refused('No such mailbox', 404);
		}
		const data = await request.formData();
		data.set('existing', 'delete');
		const problem = await resolveExistingBackup(params.id, data);
		if (problem !== null) {
			return refused(problem);
		}
		return done(`The backup of ${mailbox.address} was deleted.`);
	}
} satisfies Actions;

function setPaused(id: string, paused: boolean) {
	const mailbox = found(id);
	if (mailbox === undefined) {
		return refused('No such mailbox', 404);
	}
	setMailboxPaused(database, id, paused);
	const engine = backupEngine();
	if (paused) {
		engine.cancel(id);
	} else {
		engine.requestSync([id]);
	}
	recordActivity(database, {
		level: 'info',
		kind: 'pause',
		actor: 'console',
		summary: paused ? `${mailbox.address} was paused` : `${mailbox.address} was resumed`,
		mailboxId: id
	});
	return done(
		paused
			? `${mailbox.address} is paused. Its sync stops after the current page.`
			: `${mailbox.address} is resumed and syncs next.`
	);
}
