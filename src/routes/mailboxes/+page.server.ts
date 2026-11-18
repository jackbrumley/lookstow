import type { Actions, PageServerLoad } from './$types';
import { done, field, refused } from '#lib/server/actions.ts';
import { backupEngine, database } from '#lib/server/runtime.ts';
import { resolveExistingBackup } from '#lib/server/existing-backup.ts';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import { allMailboxes } from '#lib/server/services/mailboxes/repository.ts';
import { mailboxSummaries } from '#lib/server/services/mailboxes/views.ts';
import { readScope, setPicked } from '#lib/server/services/settings/settings.ts';

/** Every mailbox discovery has found, with its state. Filtering happens on the page. */
export const load = (() => {
	const engine = backupEngine();
	const scope = readScope(database);
	return {
		mailboxes: mailboxSummaries(database, (id) => engine.isSyncing(id)),
		picking: scope.mode === 'selected',
		picked: scope.selectedAddresses
	};
}) satisfies PageServerLoad;

/** Pick and Unpick, in the "only the mailboxes I pick" mode (Settings > What is backed up). */
async function choose(request: Request, picked: boolean) {
	const data = await request.formData();
	const address = field(data, 'address').toLowerCase();
	const rows = allMailboxes(database).filter((row) => row.address === address);
	const mailbox = rows.find((row) => row.kind !== 'archive') ?? rows[0];
	if (mailbox === undefined) {
		return refused('No such mailbox', 404);
	}
	setPicked(database, address, picked);
	if (!picked) {
		// The mailbox and its archive stop together; a delete choice covers both.
		for (const row of rows) {
			const problem = await resolveExistingBackup(row.id, data);
			if (problem !== null) {
				setPicked(database, address, true);
				return refused(problem);
			}
		}
	}
	const deleted = !picked && field(data, 'existing') === 'delete';
	recordActivity(database, {
		level: 'info',
		kind: 'mailbox-scope',
		actor: 'console',
		summary: picked
			? `${address} was picked for backup`
			: `${address} is no longer picked for backup${deleted ? ', and its backup was deleted' : ''}`,
		mailboxId: mailbox.id
	});
	if (picked) {
		backupEngine().requestSync(rows.map((row) => row.id));
	}
	return done(
		picked
			? `${address} is picked; its first copy starts now.`
			: deleted
				? `${address} is no longer picked, and its backup was deleted.`
				: `${address} is no longer picked. Its backup so far is kept.`
	);
}

export const actions = {
	pick: ({ request }) => choose(request, true),
	unpick: ({ request }) => choose(request, false)
} satisfies Actions;
