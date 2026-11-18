import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from './connection.ts';
import { databaseReadiness } from './readiness.ts';

const folders: string[] = [];

function scratchFolder(): string {
	const folder = mkdtempSync(join(tmpdir(), 'lookstow-readiness-'));
	folders.push(folder);
	return folder;
}

/** A migrations folder of `count` small migrations, as drizzle-kit lays one out. */
function migrationsWith(count: number): string {
	const folder = scratchFolder();
	mkdirSync(join(folder, 'meta'));
	const entries = Array.from({ length: count }, (_, idx) => ({
		idx,
		version: '6',
		when: 1_700_000_000_000 + idx,
		tag: `000${String(idx)}_step`,
		breakpoints: true
	}));
	for (const entry of entries) {
		writeFileSync(
			join(folder, `${entry.tag}.sql`),
			`CREATE TABLE step_${String(entry.idx)} (id integer);`
		);
	}
	writeFileSync(
		join(folder, 'meta', '_journal.json'),
		JSON.stringify({ version: '7', dialect: 'sqlite', entries })
	);
	return folder;
}

/** A fresh in-memory database with the migrations in `folder` applied. */
function migrated(folder: string): Database.Database {
	const client = new Database(':memory:');
	migrate(drizzle(client), { migrationsFolder: folder });
	return client;
}

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

describe('database readiness (GET /readyz)', () => {
	it('is ready once every committed migration is applied', () => {
		const folder = migrationsWith(2);
		expect(databaseReadiness(migrated(folder), folder)).toEqual({ kind: 'ready' });
	});

	it('is ready with the real migrations applied', () => {
		expect(databaseReadiness(migrated(MIGRATIONS_FOLDER), MIGRATIONS_FOLDER)).toEqual({
			kind: 'ready'
		});
	});

	it('is not ready while a committed migration is missing', () => {
		const readiness = databaseReadiness(migrated(migrationsWith(1)), migrationsWith(3));
		expect(readiness).toEqual({ kind: 'not-ready', reason: '1 of 3 migrations applied' });
	});

	it('is not ready when nothing was migrated or the migrations cannot be read', () => {
		expect(databaseReadiness(new Database(':memory:'), migrationsWith(1)).kind).toBe('not-ready');
		expect(
			databaseReadiness(migrated(migrationsWith(1)), join(tmpdir(), 'no-such-lookstow-folder')).kind
		).toBe('not-ready');
	});
});
