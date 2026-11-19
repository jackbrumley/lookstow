import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The email outbox: one row per alert email to one person. A send that fails waits and is tried
 * again (services/alerts/outbox.ts), so a Mailgun outage delays an alert instead of losing it.
 * Every email and its outcome stays here for the Alerts page.
 */
export const emails = sqliteTable(
	'emails',
	{
		id: text().primaryKey(),
		/** The alert type it was sent for; null for a test email. */
		alert: text(),
		recipient: text().notNull(),
		address: text().notNull(),
		subject: text().notNull(),
		bodyText: text().notNull(),
		bodyHtml: text().notNull(),
		status: text({ enum: ['queued', 'sent', 'failed', 'not-sent'] }).notNull(),
		attempts: integer().notNull().default(0),
		nextAttemptAt: integer({ mode: 'timestamp_ms' }),
		lastError: text(),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		sentAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [
		index('emails_created').on(table.createdAt),
		index('emails_due').on(table.status, table.nextAttemptAt)
	]
);
