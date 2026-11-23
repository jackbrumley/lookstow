import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { field, refused } from '#lib/server/actions.ts';
import { database } from '#lib/server/runtime.ts';
import { safeNext, signIn } from '#lib/server/services/remote/sign-in.ts';

/**
 * Remote sign-in (docs/specs/SPEC-REMOTE.md). On this computer there is nothing to sign in to,
 * so it goes to the dashboard; a signed-in person goes where they were heading.
 */
export const load = (({ locals, url }) => {
	const next = safeNext(url.searchParams.get('next'));
	if (locals.isLocal || locals.remoteUser !== null) redirect(303, next);
	return { next };
}) satisfies PageServerLoad;

export const actions = {
	default: async ({ request, cookies, locals, getClientAddress }) => {
		if (locals.isLocal) redirect(303, '/');
		const data = await request.formData();
		const username = field(data, 'username');
		const password = data.get('password');
		const next = safeNext(field(data, 'next'));
		if (username === '' || typeof password !== 'string' || password === '') {
			return refused('Enter your name and password.');
		}
		const result = await signIn(database, cookies, username, password, getClientAddress());
		if (!result.ok) return refused(result.message, 401);
		redirect(303, next);
	}
} satisfies Actions;
