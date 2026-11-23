import type { PageServerLoad } from './$types';
import { messagePageData } from '#lib/server/services/viewer/responses.ts';

/** A forwarded email inside a stored message (attachment `part`), shown as the message is. */
export const load = (({ params }) =>
	messagePageData(params.id, params.part)) satisfies PageServerLoad;
