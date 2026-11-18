import type { PageServerLoad } from './$types';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';

/** The Updates page starts from the same view GET /api/updates gives; the page then polls it. */
export const load = (() => ({ view: serverUpdates().view() })) satisfies PageServerLoad;
