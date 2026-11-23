import type { LayoutServerLoad } from './$types';
import { backupEngine, database } from '#lib/server/runtime.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import { readUpdateReminder } from '#lib/server/services/settings/settings.ts';
import { APP_VERSION } from '#lib/utils/app-version.ts';
import { LIVE_STATUS } from '#lib/domain/live-status.ts';
import { indexingText } from '#lib/domain/indexing.ts';
import { updateOffer } from '#lib/domain/releases/update-reminder.ts';
import { withoutNames } from '#lib/domain/remote.ts';

/**
 * What every page's frame shows, and the one live status every page reads
 * (docs/specs/SPEC-STATUS.md). The frame refreshes it on a timer by invalidating LIVE_STATUS;
 * page loads that show live state take it from here with parent(), never from the engine.
 */
export const load = (({ url, depends, locals }) => {
	depends(LIVE_STATUS);
	const engine = backupEngine();
	// Remote people (docs/specs/SPEC-REMOTE.md) only read: no update reminder, no names before
	// they have signed in.
	const remote = !locals.isLocal;
	const signedOut = remote && locals.remoteUser === null;
	const live = engine.live();
	return {
		remote: remote ? { user: locals.remoteUser, mayExport: locals.remoteMayExport } : null,
		// Reading the URL makes SvelteKit run this load again on every page change, so the
		// frame's banners and engine state are never left over from an earlier page.
		path: url.pathname,
		version: APP_VERSION,
		live: signedOut ? withoutNames(live) : live,
		indexing: signedOut ? null : indexingText(engine.indexing()),
		// A newer release: the sidebar's badge, and the reminder until someone answers it.
		update: remote
			? null
			: updateOffer(
					serverUpdates().view(),
					url.pathname.startsWith('/updates') ? 'updates' : 'other',
					readUpdateReminder(database),
					engine.lockdown() !== null,
					Date.now()
				)
	};
}) satisfies LayoutServerLoad;
