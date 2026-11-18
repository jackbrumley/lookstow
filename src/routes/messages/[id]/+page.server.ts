import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { database } from '#lib/server/runtime.ts';
import { messageDetail } from '#lib/server/services/messages/search.ts';

/** One stored message: where it is, its file, and its folder history. */
export const load = (({ params }) => {
	const message = messageDetail(database, params.id);
	if (message === null) {
		error(404, 'No such message');
	}
	return { message };
}) satisfies PageServerLoad;
