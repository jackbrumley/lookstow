import type { LayoutServerLoad } from './$types';
import { backupEngine } from '#lib/server/runtime.ts';
import { APP_VERSION } from '#lib/utils/app-version.ts';

/** What every page's frame shows: the version, pause state, disk state and any problem. */
export const load = (({ url }) => {
	const status = backupEngine().status();
	return {
		// Reading the URL makes SvelteKit run this load again on every page change, so the
		// frame's banners and engine state are never left over from an earlier page.
		path: url.pathname,
		version: APP_VERSION,
		busy: status.syncing.length > 0 || status.discovery.running,
		syncingCount: status.syncing.length,
		discovering: status.discovery.running,
		pause: status.pause,
		disk: status.disk,
		engineProblem: status.problem
	};
}) satisfies LayoutServerLoad;
