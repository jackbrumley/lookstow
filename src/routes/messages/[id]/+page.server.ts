import type { PageServerLoad } from './$types';
import { messagePageData } from '#lib/server/services/viewer/responses.ts';

/**
 * One stored message: where it is, its file and its folder history, and the message itself for
 * the viewer (docs/specs/SPEC-VIEWER.md), read on the reading thread so a large one never holds
 * the console.
 */
export const load = (({ params }) => messagePageData(params.id, null)) satisfies PageServerLoad;
