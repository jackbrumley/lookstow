import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import { database } from '#lib/server/runtime.ts';
import { signOut } from '#lib/server/services/remote/sign-in.ts';

/** Ends this remote session (docs/specs/SPEC-REMOTE.md) and goes back to the sign-in page. */
export const POST: RequestHandler = ({ cookies, locals }) => {
	if (locals.remoteUser !== null) {
		recordActivity(database, {
			level: 'info',
			kind: 'remote',
			actor: locals.remoteUser,
			summary: `${locals.remoteUser} signed out`
		});
	}
	signOut(cookies);
	redirect(303, locals.isLocal ? '/' : '/signin');
};
