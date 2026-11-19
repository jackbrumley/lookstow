import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** States the Mailboxes page's State list can open with, as the dashboard links to them. */
const STATES = new Set(['checking', 'needs-look', 'all']);

/**
 * A plain link to the Mailboxes page with its State list set (the dashboard's Completeness line
 * links here): /mailboxes/show/needs-look opens /mailboxes?state=needs-look.
 */
export const load = (({ params }) => {
	if (!STATES.has(params.state)) {
		error(404, 'No such view of the mailboxes');
	}
	redirect(307, `/mailboxes?state=${params.state}`);
}) satisfies PageServerLoad;
