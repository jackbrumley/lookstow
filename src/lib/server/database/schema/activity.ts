import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * What happened, in plain words, newest first on the Activity page: discovery runs, sync
 * passes, mailboxes found or gone, settings changed, updates requested. `level` lets the page
 * pick out problems.
 */
export const activity = sqliteTable(
	'activity',
	{
		id: text().primaryKey(),
		at: integer({ mode: 'timestamp_ms' }).notNull(),
		level: text({ enum: ['info', 'warn', 'error'] }).notNull(),
		kind: text().notNull(),
		/** Who did it: `system` or the person's name as given in the console. */
		actor: text().notNull(),
		summary: text().notNull(),
		detail: text(),
		mailboxId: text()
	},
	(table) => [index('activity_at').on(table.at)]
);

/** One run of discovery or of a mailbox sync, for history and the dashboard. */
export const runs = sqliteTable(
	'runs',
	{
		id: text().primaryKey(),
		kind: text({ enum: ['discovery', 'sync'] }).notNull(),
		mailboxId: text(),
		startedAt: integer({ mode: 'timestamp_ms' }).notNull(),
		finishedAt: integer({ mode: 'timestamp_ms' }),
		outcome: text({ enum: ['running', 'ok', 'failed', 'interrupted'] }).notNull(),
		/** Messages stored (sync) or mailboxes found (discovery). */
		added: integer().notNull().default(0),
		/** Messages marked deleted (sync) or mailboxes gone (discovery). */
		removed: integer().notNull().default(0),
		byteCount: integer().notNull().default(0),
		error: text()
	},
	(table) => [index('runs_started').on(table.startedAt), index('runs_mailbox').on(table.mailboxId)]
);
