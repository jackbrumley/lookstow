import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { attachContentFile } from './content-file.ts';
import * as schema from './schema.ts';
import { timeQueries } from './slow-queries.ts';

/** Drizzle over better-sqlite3; `$client` is the connection itself. */
export type AppDatabase = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** The database or an open transaction: what repositories take, so callers can group writes. */
export type Queryable = AppDatabase | Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/**
 * Where the generated migrations live, relative to the working directory: the repository in a
 * source run, `app/` in a release (scripts/release-server.ts copies them there).
 */
export const MIGRATIONS_FOLDER = 'src/lib/server/database/migrations';

/**
 * Opens (or creates) the SQLite file and applies every committed migration.
 * `:memory:` gives tests a fresh database.
 */
export function openDatabase(path: string): AppDatabase {
	if (path !== ':memory:') {
		mkdirSync(dirname(path), { recursive: true });
	}
	const client = new Database(path);
	timeQueries(client);
	// Write-ahead logging lets the console read while a sync writes.
	client.pragma('journal_mode = WAL');
	client.pragma('foreign_keys = ON');
	// Two threads write now (docs/specs/SPEC-SCALE.md): a long delete on one waits rather than fails.
	client.pragma('busy_timeout = 30000');
	// A bigger page cache (64 MB; negative means KiB) and memory-mapped reads (256 MB) keep a large
	// index's busy pages in memory instead of reading them from disk for every query.
	client.pragma('cache_size = -65536');
	client.pragma('mmap_size = 268435456');
	client.pragma('temp_store = MEMORY');
	attachContentFile(client, path);
	const database = drizzle(client, { schema, casing: 'snake_case' });
	migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
	return database;
}
