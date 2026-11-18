import type { Actions, PageServerLoad } from './$types';
import { done, field, refused } from '#lib/server/actions.ts';
import { backupEngine, database } from '#lib/server/runtime.ts';
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
	const address = field(await request.formData(), 'address').toLowerCase();
	const mailbox = allMailboxes(database).find((row) => row.address === address);
	if (mailbox === undefined) {
		return refused('No such mailbox', 404);
	}
	setPicked(database, address, picked);
	recordActivity(database, {
		level: 'info',
		kind: 'mailbox-scope',
		actor: 'console',
		summary: picked
			? `${address} was picked for backup`
			: `${address} is no longer picked for backup`,
		mailboxId: mailbox.id
	});
	if (picked) {
		backupEngine().requestSync(
			allMailboxes(database)
				.filter((row) => row.address === address)
				.map((row) => row.id),
			'picked'
		);
	}
	return done(
		picked
			? `${address} is picked; its first copy starts now.`
			: `${address} is no longer picked. Its backup so far is kept.`
	);
}

export const actions = {
	pick: ({ request }) => choose(request, true),
	unpick: ({ request }) => choose(request, false)
} satisfies Actions;
