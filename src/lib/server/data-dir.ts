import { dirname, resolve } from 'node:path';
import { env } from './env.ts';

/** The data folder: the installed service's, or the one holding the database in a source run. */
export function dataDir(): string {
	return env.launcher.kind === 'installed'
		? env.launcher.dataDir
		: resolve(dirname(env.databasePath));
}
