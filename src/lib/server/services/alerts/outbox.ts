import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, lte } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { emails } from '../../database/schema.ts';
import {
	ALERT_TYPES,
	type AlertRecipient,
	type EmailStatus,
	type EmailView
} from '../../../domain/alerts.ts';
import type { MailgunSetup } from '../settings/settings.ts';
import { renderEmail, type EmailSource } from './email-content.ts';
import { sendMailgun, type MailFetch } from './mailgun.ts';

/**
 * The outbox, after i12-pt6-control's: an alert becomes one row per person, and a send pass
 * sends what is due. A failed send is tried again after 1, 5, 15 and 30 minutes, then hourly,
 * eight tries in all, so a Mailgun outage delays an alert instead of losing it. Without a Mailgun
 * setup an email is recorded as not sent, so the page shows what would have gone and nothing
 * piles up to go out at once later.
 */
const RETRY_MINUTES = [1, 5, 15, 30, 60, 60, 60] as const;
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
/** Emails sent in one pass; the rest wait for the next. */
const PASS_LIMIT = 50;
export const NOT_SET_UP = 'Email is not set up: add the Mailgun setup on the Alerts page.';

/**
 * Puts one email per matching person in the outbox; returns the new emails' ids. A test email
 * (no alert type) goes to everyone it is given.
 */
export function enqueue(
	db: Queryable,
	recipients: readonly AlertRecipient[],
	source: EmailSource,
	ready: boolean,
	now: number
): string[] {
	const queued: string[] = [];
	for (const recipient of recipients) {
		const wanted =
			source.alert === null || (recipient.enabled && recipient.alerts.includes(source.alert));
		if (!wanted) continue;
		const email = renderEmail(source, recipient.name);
		const id = randomUUID();
		db.insert(emails)
			.values({
				id,
				alert: source.alert,
				recipient: recipient.name,
				address: recipient.email,
				subject: email.subject,
				bodyText: email.text,
				bodyHtml: email.html,
				status: ready ? 'queued' : 'not-sent',
				nextAttemptAt: ready ? new Date(now) : null,
				lastError: ready ? null : NOT_SET_UP,
				createdAt: new Date(now)
			})
			.run();
		queued.push(id);
	}
	return queued;
}

/** One pass: sends every email that is due, and schedules a retry for each failure. */
export async function sendDue(
	db: Queryable,
	setup: MailgunSetup,
	now: () => number,
	fetchImpl?: MailFetch
): Promise<void> {
	const due = db
		.select()
		.from(emails)
		.where(and(eq(emails.status, 'queued'), lte(emails.nextAttemptAt, new Date(now()))))
		.orderBy(asc(emails.createdAt))
		.limit(PASS_LIMIT)
		.all();
	for (const row of due) {
		const attempts = row.attempts + 1;
		try {
			await sendMailgun(
				setup,
				{ to: row.address, subject: row.subject, text: row.bodyText, html: row.bodyHtml },
				fetchImpl
			);
			db.update(emails)
				.set({
					status: 'sent',
					attempts,
					sentAt: new Date(now()),
					lastError: null,
					nextAttemptAt: null
				})
				.where(eq(emails.id, row.id))
				.run();
		} catch (error) {
			const retryIn = RETRY_MINUTES[attempts - 1];
			const giveUp = attempts >= MAX_ATTEMPTS || retryIn === undefined;
			db.update(emails)
				.set({
					status: giveUp ? 'failed' : 'queued',
					attempts,
					lastError: error instanceof Error ? error.message : String(error),
					nextAttemptAt: giveUp ? null : new Date(now() + retryIn * 60_000)
				})
				.where(eq(emails.id, row.id))
				.run();
		}
	}
}

function toView(row: typeof emails.$inferSelect): EmailView {
	const alert = ALERT_TYPES.find((type) => type === row.alert) ?? null;
	const status: EmailStatus = row.status;
	return {
		id: row.id,
		alert,
		recipient: row.recipient,
		address: row.address,
		subject: row.subject,
		status,
		attempts: row.attempts,
		lastError: row.lastError,
		createdAt: row.createdAt.toISOString(),
		sentAt: row.sentAt?.toISOString() ?? null
	};
}

export function listEmails(db: Queryable, limit: number): EmailView[] {
	return db.select().from(emails).orderBy(desc(emails.createdAt)).limit(limit).all().map(toView);
}

export function emailById(db: Queryable, id: string): EmailView | null {
	const row = db.select().from(emails).where(eq(emails.id, id)).get();
	return row === undefined ? null : toView(row);
}

export function countEmails(db: Queryable): number {
	return db.select({ total: count() }).from(emails).get()?.total ?? 0;
}
