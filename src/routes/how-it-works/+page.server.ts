import type { PageServerLoad } from './$types';
import { database, dataDir } from '#lib/server/runtime.ts';
import { effectiveBackupRoot, readSchedule } from '#lib/server/services/settings/settings.ts';
import { snapshotFolder, SNAPSHOTS_KEPT } from '#lib/server/services/storage/index-snapshot.ts';

/** How Lookstow works, in plain words, with this installation's own schedule and folders. */
export const load = (() => {
	const schedule = readSchedule(database);
	const backupRoot = effectiveBackupRoot(database, dataDir());
	return {
		syncEveryMinutes: schedule.syncEveryMinutes,
		discoverEveryHours: schedule.discoverEveryHours,
		dataDir: dataDir(),
		backupRoot,
		snapshotFolder: snapshotFolder(backupRoot),
		snapshotsKept: SNAPSHOTS_KEPT
	};
}) satisfies PageServerLoad;
