import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Remote sign-ins (docs/specs/SPEC-REMOTE.md), kept so a restart or an update does not sign
 * everyone out. Only the SHA-256 of the cookie's token is stored, so the table cannot be used to
 * sign in.
 */
export const remoteSessions = sqliteTable(
	'remote_sessions',
	{
		tokenSha256: text().primaryKey(),
		username: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		seenAt: integer({ mode: 'timestamp_ms' }).notNull()
	},
	(table) => [index('remote_sessions_username').on(table.username)]
);
