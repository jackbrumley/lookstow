import type { LayoutServerLoad } from './$types';
import { backupEngine, database } from '#lib/server/runtime.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import { readUpdateReminder } from '#lib/server/services/settings/settings.ts';
import { APP_VERSION } from '#lib/utils/app-version.ts';
import { LIVE_STATUS } from '#lib/domain/live-status.ts';
import { indexingText } from '#lib/domain/indexing.ts';
import { updateOffer } from '#lib/domain/releases/update-reminder.ts';

/**
 * What every page's frame shows, and the one live status every page reads
 * (docs/specs/SPEC-STATUS.md). The frame refreshes it on a timer by invalidating LIVE_STATUS;
 * page loads that show live state take it from here with parent(), never from the engine.
 */
export const load = (({ url, depends }) => {
	depends(LIVE_STATUS);
	const engine = backupEngine();
	return {
		// Reading the URL makes SvelteKit run this load again on every page change, so the
		// frame's banners and engine state are never left over from an earlier page.
		path: url.pathname,
		version: APP_VERSION,
		live: engine.live(),
		indexing: indexingText(engine.indexing()),
		// A newer release: the sidebar's badge, and the reminder until someone answers it.
		update: updateOffer(
			serverUpdates().view(),
			url.pathname.startsWith('/updates') ? 'updates' : 'other',
			readUpdateReminder(database),
			engine.lockdown() !== null,
			Date.now()
		)
	};
}) satisfies LayoutServerLoad;
