import type { LayoutServerLoad } from './$types';
import { backupEngine } from '#lib/server/runtime.ts';
import { APP_VERSION } from '#lib/utils/app-version.ts';

/** What every page's frame shows: the version and whether the engine is busy or stuck. */
export const load = (() => {
	const status = backupEngine().status();
	return {
		version: APP_VERSION,
		enginePhase: status.phase,
		engineProblem: status.problem,
		paused: status.paused
	};
}) satisfies LayoutServerLoad;
