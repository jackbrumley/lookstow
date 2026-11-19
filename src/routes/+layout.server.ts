import type { LayoutServerLoad } from './$types';
import { backupEngine } from '#lib/server/runtime.ts';
import { liveStatus } from '#lib/server/services/engine/live-status.ts';
import { APP_VERSION } from '#lib/utils/app-version.ts';
import { LIVE_STATUS } from '#lib/domain/live-status.ts';

/**
 * What every page's frame shows, and the one live status every page reads
 * (docs/specs/SPEC-STATUS.md). The frame refreshes it on a timer by invalidating LIVE_STATUS;
 * page loads that show live state take it from here with parent(), never from the engine.
 */
export const load = (({ url, depends }) => {
	depends(LIVE_STATUS);
	return {
		// Reading the URL makes SvelteKit run this load again on every page change, so the
		// frame's banners and engine state are never left over from an earlier page.
		path: url.pathname,
		version: APP_VERSION,
		live: liveStatus(backupEngine())
	};
}) satisfies LayoutServerLoad;
