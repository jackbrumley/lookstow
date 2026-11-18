import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Settings as key and JSON value, one row per setting. The settings service owns the keys
 * and validates every value with zod on read; a value that no longer validates is reported,
 * never silently replaced.
 */
export const settings = sqliteTable('settings', {
	key: text().primaryKey(),
	value: text().notNull(),
	updatedAt: integer({ mode: 'timestamp_ms' }).notNull()
});
