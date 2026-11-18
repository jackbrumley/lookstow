import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Whether the database is ready to serve (GET /readyz): it answers a query and
 * every committed migration has been applied. The installers wait on this
 * before printing the console's address; the reason goes to the log, never to
 * the caller.
 */
export type Readiness = { kind: 'ready' } | { kind: 'not-ready'; reason: string };

const Journal = z.object({ entries: z.array(z.object({ tag: z.string() })) });
const AppliedCount = z.object({ applied: z.number() });

/** `client` is the database's own connection (`database.$client`). */
export function databaseReadiness(client: Database.Database, migrationsFolder: string): Readiness {
	try {
		const committed = Journal.parse(
			JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'))
		).entries.length;
		const { applied } = AppliedCount.parse(
			client.prepare('select count(*) as applied from __drizzle_migrations').get()
		);
		if (applied < committed) {
			return {
				kind: 'not-ready',
				reason: `${String(applied)} of ${String(committed)} migrations applied`
			};
		}
		return { kind: 'ready' };
	} catch (error) {
		return {
			kind: 'not-ready',
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}
