import { dirname, resolve } from 'node:path';
import { database } from './database/app-database.ts';
import { env } from './env.ts';
import { Alerts } from './services/alerts/alerts.ts';
import { Engine } from './services/engine/engine.ts';

/**
 * The process's running parts, made once: the database (opened and migrated on import), the
 * data folder, and the backup engine. Routes and hooks reach them through here, never by
 * building their own.
 */
export function dataDir(): string {
	return env.launcher.kind === 'installed'
		? env.launcher.dataDir
		: resolve(dirname(env.databasePath));
}

let engine: Engine | null = null;

export function backupEngine(): Engine {
	engine ??= new Engine({ db: database, dataDir: dataDir(), secretsKey: env.secretsKey });
	return engine;
}

let alerts: Alerts | null = null;

export function alertService(): Alerts {
	alerts ??= new Alerts({ db: database, secretsKey: env.secretsKey });
	return alerts;
}

export { database };
