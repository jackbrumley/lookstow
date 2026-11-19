import type { Queryable } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import type { AlertRecipient, EmailView } from '../../../domain/alerts.ts';
import { onActivity, type NewActivity } from '../activity/activity.ts';
import { mailgunSetup, readRecipients } from '../settings/settings.ts';
import { alertFor } from './alert-rules.ts';
import type { MailFetch } from './mailgun.ts';
import { emailById, enqueue, sendDue } from './outbox.ts';

/**
 * Email alerts, running: every activity entry worth an email goes into the outbox for the people
 * who chose that alert, and a timer sends what is due every 30 seconds (and at once after an
 * alert). One send pass runs at a time.
 */
const SEND_EVERY_MS = 30_000;

export type AlertsDeps = {
	db: Queryable;
	secretsKey: Buffer;
	now?: () => number;
	fetch?: MailFetch;
};

export class Alerts {
	readonly #db: Queryable;
	readonly #secretsKey: Buffer;
	readonly #now: () => number;
	readonly #fetch: MailFetch | undefined;
	#timer: NodeJS.Timeout | null = null;
	#unsubscribe: (() => void) | null = null;
	#sending: Promise<void> | null = null;
	/** The one extra pass asked for while a pass runs. */
	#again: Promise<void> | null = null;

	constructor(deps: AlertsDeps) {
		this.#db = deps.db;
		this.#secretsKey = deps.secretsKey;
		this.#now = deps.now ?? Date.now;
		this.#fetch = deps.fetch;
	}

	start(): void {
		this.stop();
		this.#unsubscribe = onActivity((db, entry) => {
			this.#queueFor(db, entry);
		});
		this.#timer = setInterval(() => {
			void this.sendDue();
		}, SEND_EVERY_MS);
		this.#timer.unref();
		void this.sendDue();
	}

	stop(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		if (this.#timer !== null) clearInterval(this.#timer);
		this.#timer = null;
	}

	#queueFor(db: Queryable, entry: NewActivity): void {
		const source = alertFor({
			level: entry.level,
			kind: entry.kind,
			actor: entry.actor,
			summary: entry.summary,
			detail: entry.detail ?? null
		});
		if (source === null) return;
		const ready = mailgunSetup(db, this.#secretsKey) !== null;
		// The outbox runs on this service's clock, so "due" means the same to both.
		const queued = enqueue(db, readRecipients(db), source, ready, this.#now());
		if (queued.length > 0 && ready) void this.sendDue();
	}

	/**
	 * Sends every email that is due. One pass runs at a time; a call while one runs gets one
	 * more pass after it, so an alert queued mid-pass goes out now, not at the next timer.
	 */
	sendDue(): Promise<void> {
		if (this.#sending !== null) {
			this.#again ??= this.#sending.then(() => {
				this.#again = null;
				return this.sendDue();
			});
			return this.#again;
		}
		this.#sending = this.#sendPass().finally(() => {
			this.#sending = null;
		});
		return this.#sending;
	}

	async #sendPass(): Promise<void> {
		try {
			const setup = mailgunSetup(this.#db, this.#secretsKey);
			if (setup === null) return;
			await sendDue(this.#db, setup, this.#now, this.#fetch);
		} catch (error) {
			serverLog('error', 'alerts', `Sending alert emails failed: ${errorText(error)}`);
		}
	}

	/** Sends a test email to one person now, and returns how it went. */
	async sendTest(recipient: AlertRecipient, by: string): Promise<EmailView | null> {
		const ready = mailgunSetup(this.#db, this.#secretsKey) !== null;
		const [id] = enqueue(
			this.#db,
			[recipient],
			{
				alert: null,
				title: 'Test email',
				body: `${by} sent this test from the Alerts page. If you can read it, alerts reach you.`,
				page: 'Alerts'
			},
			ready,
			this.#now()
		);
		await this.sendDue();
		return id === undefined ? null : emailById(this.#db, id);
	}
}
