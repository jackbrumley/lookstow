/**
 * The one place server code reads environment variables. A missing or wrong
 * value stops the server at start-up (fail hard), never later at first use.
 *
 * Only what the process needs before it can open its database lives here:
 * where the database is, the key for secrets at rest, where to listen, and
 * what the launcher tells the app. Lookstow's own settings (tenants,
 * mailboxes, schedules, the backup folder) live in the database and are
 * changed in the console.
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Variables already set (the launcher's --env-file, the shell) win over .env.
if (existsSync('.env')) {
	process.loadEnvFile('.env');
}

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(`Environment variable ${name} is not set (see .env.example)`);
	}
	return value;
}

/** A variable that may be left out; empty counts as not set. */
function optional(name: string): string | undefined {
	const value = process.env[name];
	return value === undefined || value === '' ? undefined : value;
}

function secretsKey(): Buffer {
	const key = Buffer.from(required('SECRETS_KEY'), 'base64');
	if (key.length !== 32) {
		throw new Error('SECRETS_KEY must be 32 random bytes in base64 (openssl rand -base64 32)');
	}
	return key;
}

/** PORT, 8030 when left out: the console is http://127.0.0.1:8030. */
function port(): number {
	const text = optional('PORT') ?? '8030';
	const value = /^\d{1,5}$/.test(text) ? Number.parseInt(text, 10) : 0;
	if (value < 1 || value > 65_535) {
		throw new Error(`PORT must be a port number (1 to 65535), not ${text}`);
	}
	return value;
}

/**
 * How this server was started. An installed server's launcher passes its data
 * folder (where the app writes the update request and reads the updater's
 * status), its target and a nonce the app writes back in ready.json.
 */
export type LauncherConfig =
	| { kind: 'source' }
	| {
			kind: 'installed';
			dataDir: string;
			target: 'x86_64-unknown-linux-gnu' | 'x86_64-pc-windows-msvc';
			nonce: string;
	  };

function launcherConfig(): LauncherConfig {
	const kind = optional('LOOKSTOW_DEPLOYMENT') ?? 'source';
	const dataDir = optional('LOOKSTOW_UPDATE_DATA');
	const target = optional('LOOKSTOW_LAUNCHER_TARGET');
	const nonce = optional('LOOKSTOW_READINESS_NONCE');
	if (kind === 'source') {
		if ([dataDir, target, nonce].some((value) => value !== undefined)) {
			throw new Error('Launcher settings require LOOKSTOW_DEPLOYMENT=installed');
		}
		return { kind };
	}
	if (
		kind !== 'installed' ||
		dataDir === undefined ||
		!isAbsolute(dataDir) ||
		nonce === undefined ||
		!/^[a-f0-9]{64}$/.test(nonce) ||
		(target !== 'x86_64-unknown-linux-gnu' && target !== 'x86_64-pc-windows-msvc')
	) {
		throw new Error('Installed server launcher settings are incomplete or invalid');
	}
	return { kind, dataDir, target, nonce };
}

/**
 * The work thread's entry file (docs/specs/SPEC-SCALE.md), which server.ts sets before the app
 * loads: app/work.js in a release. Read when the thread starts, not when this module loads.
 */
export function workEntryPath(): string | undefined {
	return optional('LOOKSTOW_WORK_ENTRY');
}

export const env = {
	/** Path to the SQLite database file, e.g. ./data/lookstow.db; `:memory:` in tests. */
	databasePath: required('DATABASE_PATH'),
	/** Encrypts secrets at rest (Microsoft 365 app credentials). */
	secretsKey: secretsKey(),
	/** Where the console listens: 127.0.0.1 unless HOST says otherwise. */
	host: optional('HOST') ?? '127.0.0.1',
	port: port(),
	/** Set by the launcher (LOOKSTOW_*); a source run has none. */
	launcher: launcherConfig()
	// App settings read from the environment go here, each parsed by its own
	// function above so a wrong value stops start-up. Prefer a setting in the
	// database: only what is needed before the database opens belongs here.
};
