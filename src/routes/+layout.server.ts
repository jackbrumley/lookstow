import type { LayoutServerLoad } from './$types';
import { backupEngine } from '#lib/server/runtime.ts';
import { APP_VERSION } from '#lib/utils/app-version.ts';

/** What every page's frame shows: the version and whether the engine is busy or stuck. */
export const load = (({ url }) => {
	const status = backupEngine().status();
	return {
		// Reading the URL makes SvelteKit run this load again on every page change, so the
		// frame's banner and engine state are never left over from an earlier page.
		path: url.pathname,
		version: APP_VERSION,
		enginePhase: status.phase,
		engineProblem: status.problem,
		paused: status.paused
	};
}) satisfies LayoutServerLoad;
