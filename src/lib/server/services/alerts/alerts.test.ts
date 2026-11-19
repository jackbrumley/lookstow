import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { emails } from '../../database/schema.ts';
import { recordActivity } from '../activity/activity.ts';
import {
	mailgunSetup,
	mailgunView,
	readRecipients,
	saveMailgun,
	saveRecipients
} from '../settings/settings.ts';
import { alertFor } from './alert-rules.ts';
import { Alerts } from './alerts.ts';
import { renderEmail } from './email-content.ts';
import { sendMailgun } from './mailgun.ts';
import { enqueue, listEmails, MAX_ATTEMPTS, NOT_SET_UP, sendDue } from './outbox.ts';
import type { AlertRecipient } from '../../../domain/alerts.ts';

const KEY = Buffer.alloc(32, 7);
// Invented, and shaped unlike a real Mailgun key so secret scanners leave it alone.
const MAILGUN_KEY = 'test-sending-key-made-up-for-tests-cdef';

type Sent = { url: string; authorization: string | null; form: URLSearchParams };

/** A fake Mailgun: records each send and answers with the given status. */
function fakeMailgun(statuses: number[] = []) {
	const sent: Sent[] = [];
	const fetchImpl = (url: string, init: RequestInit): Promise<Response> => {
		const headers = new Headers(init.headers);
		const body = init.body;
		sent.push({
			url,
			authorization: headers.get('authorization'),
			form: body instanceof URLSearchParams ? body : new URLSearchParams()
		});
		const status = statuses.shift() ?? 200;
		return Promise.resolve(new Response(status === 200 ? '{"id":"x"}' : 'Forbidden', { status }));
	};
	return { sent, fetchImpl };
}

const ANN: AlertRecipient = {
	id: 'ann',
	name: 'Ann',
	email: 'ann@example.com',
	enabled: true,
	alerts: ['mailbox-problems', 'disk']
};
const BOB: AlertRecipient = {
	id: 'bob',
	name: 'Bob',
	email: 'bob@example.com',
	enabled: true,
	alerts: ['first-copy']
};
const OFF: AlertRecipient = {
	id: 'off',
	name: 'Off',
	email: 'off@example.com',
	enabled: false,
	alerts: ['mailbox-problems']
};

function setUp() {
	const db = openDatabase(':memory:');
	saveMailgun(
		db,
		{ domain: 'mg.example.com', from: '', region: 'eu', apiKey: MAILGUN_KEY },
		KEY,
		1
	);
	saveRecipients(db, [ANN, BOB, OFF], 1);
	return db;
}

describe('sending through Mailgun', () => {
	it('posts the email to the region’s API host with the key as basic auth', async () => {
		const { sent, fetchImpl } = fakeMailgun();
		await sendMailgun(
			{ domain: 'mg.example.com', from: 'L <l@mg.example.com>', region: 'eu', apiKey: 'k' },
			{ to: 'ann@example.com', subject: 'S', text: 'T', html: '<p>H</p>' },
			fetchImpl
		);
		expect(sent[0]?.url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
		expect(sent[0]?.authorization).toBe(`Basic ${Buffer.from('api:k').toString('base64')}`);
		expect(sent[0]?.form.get('to')).toBe('ann@example.com');
		expect(sent[0]?.form.get('from')).toBe('L <l@mg.example.com>');
	});

	it('says what to check when Mailgun refuses the key', async () => {
		const { fetchImpl } = fakeMailgun([401]);
		await expect(
			sendMailgun(
				{ domain: 'mg.example.com', from: 'f', region: 'us', apiKey: 'k' },
				{ to: 'a@example.com', subject: 'S', text: 'T', html: 'H' },
				fetchImpl
			)
		).rejects.toThrow(/Mailgun refused it \(401: Forbidden\)\. Check the sending key/);
	});
});

describe('which activity is an alert', () => {
	const entry = { level: 'error' as const, actor: 'system', summary: 'S', detail: null };

	it('turns failures and changes into alerts, and leaves a person’s own actions alone', () => {
		expect(alertFor({ ...entry, kind: 'sync' })?.alert).toBe('mailbox-problems');
		expect(alertFor({ ...entry, kind: 'sync', actor: 'console' })).toBeNull();
		expect(alertFor({ ...entry, kind: 'discovery' })?.alert).toBe('discovery-problems');
		expect(alertFor({ ...entry, kind: 'discovery', level: 'info' })).toBeNull();
		expect(alertFor({ ...entry, kind: 'pause' })?.alert).toBe('disk');
		expect(alertFor({ ...entry, kind: 'pause', actor: 'console' })).toBeNull();
		expect(alertFor({ ...entry, kind: 'mailbox-gone' })?.alert).toBe('mailboxes-changed');
		expect(alertFor({ ...entry, kind: 'first-copy' })?.alert).toBe('first-copy');
		expect(alertFor({ ...entry, kind: 'backup-deleted', actor: 'console' })?.alert).toBe(
			'backups-deleted'
		);
		expect(alertFor({ ...entry, kind: 'update-requested' })?.alert).toBe('updates');
		expect(alertFor({ ...entry, kind: 'update-requested', actor: 'console' })).toBeNull();
		expect(alertFor({ ...entry, kind: 'settings' })).toBeNull();
		expect(alertFor({ ...entry, kind: 'completeness' })?.alert).toBe('completeness');
		expect(alertFor({ ...entry, kind: 'completeness', level: 'info' })).toBeNull();
	});
});

describe('the alert email', () => {
	it('escapes every value in the HTML version', () => {
		const email = renderEmail(
			{ alert: 'mailbox-problems', title: 'T', body: 'Subject <script>x</script>', page: 'P' },
			'Ann & co',
			'SERVER1'
		);
		expect(email.subject).toBe('Lookstow: T');
		expect(email.html).toContain('Subject &lt;script&gt;x&lt;/script&gt;');
		expect(email.html).toContain('Hi Ann &amp; co,');
		expect(email.text).toContain('More is in the Lookstow console on SERVER1, under P.');
	});
});

describe('the outbox', () => {
	it('queues one email for each person who ticked the alert and gets email', () => {
		const db = setUp();
		const ids = enqueue(
			db,
			readRecipients(db),
			{ alert: 'mailbox-problems', title: 'T', body: 'B', page: 'P' },
			true,
			1000
		);
		expect(ids).toHaveLength(1);
		expect(listEmails(db, 10).map((email) => [email.address, email.status])).toEqual([
			['ann@example.com', 'queued']
		]);
	});

	it('records alerts as not sent while email is not set up', () => {
		const db = setUp();
		enqueue(db, [ANN], { alert: 'disk', title: 'T', body: 'B', page: 'P' }, false, 1000);
		expect(listEmails(db, 10)[0]).toMatchObject({ status: 'not-sent', lastError: NOT_SET_UP });
	});

	it('tries a failed send again later, and gives up after eight tries', async () => {
		const db = setUp();
		const setup = mailgunSetup(db, KEY);
		if (setup === null) throw new Error('no setup');
		enqueue(db, [ANN], { alert: 'disk', title: 'T', body: 'B', page: 'P' }, true, 0);
		let now = 0;
		const { sent, fetchImpl } = fakeMailgun(Array.from({ length: MAX_ATTEMPTS }, () => 500));
		await sendDue(db, setup, () => now, fetchImpl);
		const [first] = db.select().from(emails).all();
		expect(first).toMatchObject({ status: 'queued', attempts: 1 });
		expect(first?.nextAttemptAt?.getTime()).toBe(60_000);
		// Not due yet: nothing is sent.
		await sendDue(db, setup, () => now, fetchImpl);
		expect(sent).toHaveLength(1);
		for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
			now += 61 * 60_000;
			await sendDue(db, setup, () => now, fetchImpl);
		}
		expect(listEmails(db, 1)[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
		expect(sent).toHaveLength(MAX_ATTEMPTS);
	});
});

describe('alerts while Lookstow runs', () => {
	it('emails the people who chose an alert when its activity is recorded', async () => {
		const db = setUp();
		const { sent, fetchImpl } = fakeMailgun();
		const alerts = new Alerts({ db, secretsKey: KEY, now: () => 5000, fetch: fetchImpl });
		alerts.start();
		try {
			recordActivity(db, {
				level: 'error',
				kind: 'sync',
				actor: 'system',
				summary: 'Sync of ann@example.com failed',
				detail: 'Microsoft refused it'
			});
			await alerts.sendDue();
		} finally {
			alerts.stop();
		}
		expect(sent.map((email) => email.form.get('to'))).toEqual(['ann@example.com']);
		expect(sent[0]?.form.get('subject')).toBe('Lookstow: Sync of ann@example.com failed');
		expect(listEmails(db, 10)[0]).toMatchObject({ status: 'sent', attempts: 1 });
		// Stopped: activity sends nothing more.
		recordActivity(db, { level: 'info', kind: 'first-copy', actor: 'system', summary: 'Done' });
		expect(listEmails(db, 10)).toHaveLength(1);
	});

	it('sends a test email at once and reports how it went', async () => {
		const db = setUp();
		const { fetchImpl } = fakeMailgun([401]);
		const alerts = new Alerts({ db, secretsKey: KEY, now: () => 5000, fetch: fetchImpl });
		const result = await alerts.sendTest(BOB, 'Jack');
		expect(result).toMatchObject({ status: 'queued', address: 'bob@example.com', attempts: 1 });
		expect(result?.lastError).toMatch(/Mailgun refused it \(401/);
	});
});

describe('the email settings', () => {
	it('seals the key, shows only a hint, and keeps the key when it is left blank', () => {
		const db = setUp();
		const view = mailgunView(db);
		expect(view).toMatchObject({
			kind: 'set',
			domain: 'mg.example.com',
			from: 'Lookstow <lookstow@mg.example.com>',
			keyHint: '…cdef'
		});
		expect(JSON.stringify(view)).not.toContain(MAILGUN_KEY);
		saveMailgun(
			db,
			{ domain: 'mg2.example.com', from: 'X <x@y.z>', region: 'us', apiKey: '' },
			KEY
		);
		expect(mailgunSetup(db, KEY)).toEqual({
			domain: 'mg2.example.com',
			from: 'X <x@y.z>',
			region: 'us',
			apiKey: MAILGUN_KEY
		});
	});

	it('refuses a bad domain, region or key, and a person listed twice', () => {
		const db = openDatabase(':memory:');
		const good = { domain: 'mg.example.com', from: '', region: 'us', apiKey: MAILGUN_KEY };
		expect(() => {
			saveMailgun(db, { ...good, domain: 'not a domain' }, KEY);
		}).toThrow(/domain name/);
		expect(() => {
			saveMailgun(db, { ...good, region: 'mars' }, KEY);
		}).toThrow(/US or EU/);
		expect(() => {
			saveMailgun(db, { ...good, apiKey: '' }, KEY);
		}).toThrow(/Paste the Mailgun sending key/);
		expect(() => {
			saveMailgun(db, { ...good, from: 'a\nBcc: b@c.d' }, KEY);
		}).toThrow(/one line/);
		expect(() => {
			saveRecipients(db, [ANN, { ...BOB, email: 'ANN@example.com' }]);
		}).toThrow(/once/);
		expect(() => {
			saveRecipients(db, [{ ...ANN, email: 'nope' }]);
		}).toThrow(/not an email address/);
	});
});
