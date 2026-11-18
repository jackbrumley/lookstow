import type { PageServerLoad } from './$types';
import { logSince } from '#lib/server/log.ts';

/** The Log page starts from the lines the service holds now, then asks for newer ones. */
export const load = (() => ({ lines: logSince(0) })) satisfies PageServerLoad;
