import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { mailboxes, mailFolders } from './mailboxes.ts';

/**
 * Messages and archive items that could not be copied (docs/specs/SPEC-THROUGHPUT.md 4.9.4): one
 * bad item never stops its folder. The folder's delta moves on; the item waits here and is tried
 * again on later syncs, with growing gaps, until it is copied (and its row removed) or has
 * failed TERMINAL_ATTEMPTS times, when the console shows it for someone to look at.
 */
export const itemFailures = sqliteTable(
	'item_failures',
	{
		id: text().primaryKey(),
		mailboxId: text()
			.notNull()
			.references(() => mailboxes.id, { onDelete: 'cascade' }),
		folderId: text()
			.notNull()
			.references(() => mailFolders.id, { onDelete: 'cascade' }),
		graphId: text().notNull(),
		/** What the delta said about it, to file it when it is copied (mail only). */
		subject: text().notNull().default(''),
		receivedAt: integer({ mode: 'timestamp_ms' }),
		attempts: integer().notNull().default(1),
		firstFailedAt: integer({ mode: 'timestamp_ms' }).notNull(),
		nextTryAt: integer({ mode: 'timestamp_ms' }).notNull(),
		lastError: text().notNull(),
		/** Tried too often: no more automatic tries. */
		terminal: integer({ mode: 'boolean' }).notNull().default(false)
	},
	(table) => [
		uniqueIndex('item_failures_item').on(table.mailboxId, table.graphId),
		index('item_failures_due').on(table.folderId, table.terminal, table.nextTryAt)
	]
);
