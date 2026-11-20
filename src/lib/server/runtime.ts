import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { database } from './database/app-database.ts';
import { dataDir } from './data-dir.ts';
import { workEntryPath } from './env.ts';
import { WorkThread } from './work/work-client.ts';
import { APP_VERSION } from '../utils/app-version.ts';

/**
 * The web thread's running parts, made once: its database connection (opened and migrated on
 * import), the data folder, and the work thread that runs the backup engine
 * (docs/specs/SPEC-SCALE.md). Routes and hooks reach them through here, never by building
 * their own.
 */
let work: WorkThread | null = null;

/**
 * The work thread's entry: app/work.js beside a release's server.js (server.ts says where), or
 * the source file in a source run.
 */
function workEntry(): URL {
	return pathToFileURL(workEntryPath() ?? resolve('src/lib/server/work/work-thread.ts'));
}

/** Starts the work thread and waits for its first snapshot. */
export async function startWork(): Promise<WorkThread> {
	work ??= new WorkThread(workEntry(), APP_VERSION);
	await work.started();
	return work;
}

/** The backup engine, on the work thread. */
export function backupEngine(): WorkThread {
	if (work === null) throw new Error('The backup engine has not started yet.');
	return work;
}

export { database, dataDir };
