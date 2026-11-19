import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { checked, done, errorMessage, field, refused } from '#lib/server/actions.ts';
import { env } from '#lib/server/env.ts';
import { alertService, database } from '#lib/server/runtime.ts';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import { countEmails, listEmails } from '#lib/server/services/alerts/outbox.ts';
import {
	clearMailgun,
	mailgunView,
	readRecipients,
	saveMailgun,
	saveRecipients
} from '#lib/server/services/settings/settings.ts';
import { ALERT_TYPES, type AlertRecipient } from '#lib/domain/alerts.ts';

const SHOWN_EMAILS = 50;

/** Alerts: the Mailgun setup, who gets which alert emails, and every email with its outcome. */
export const load = (() => ({
	mailgun: mailgunView(database),
	recipients: readRecipients(database),
	emails: listEmails(database, SHOWN_EMAILS),
	emailCount: countEmails(database)
})) satisfies PageServerLoad;

function noted(summary: string, message: string) {
	recordActivity(database, { level: 'info', kind: 'settings', actor: 'console', summary });
	return done(message);
}

/** The person in the form: name, address, whether they get email, and their ticked alerts. */
function recipientFrom(data: FormData, id: string): AlertRecipient {
	return {
		id,
		name: field(data, 'name'),
		email: field(data, 'email').toLowerCase(),
		enabled: checked(data, 'enabled'),
		alerts: ALERT_TYPES.filter((type) => checked(data, `alert-${type}`))
	};
}

function attempt(work: () => ReturnType<typeof done>) {
	try {
		return work();
	} catch (error) {
		return refused(errorMessage(error));
	}
}

export const actions = {
	mailgun: async ({ request }) => {
		const data = await request.formData();
		return attempt(() => {
			saveMailgun(
				database,
				{
					domain: field(data, 'domain'),
					from: field(data, 'from'),
					region: field(data, 'region'),
					apiKey: field(data, 'apiKey')
				},
				env.secretsKey
			);
			return noted('Alerts: the Mailgun setup was saved', 'Saved. Send a test email to check it.');
		});
	},
	clearMailgun: () => {
		clearMailgun(database);
		return noted(
			'Alerts: the Mailgun setup was removed',
			'Removed. Alerts are recorded as not sent until it is set up again.'
		);
	},
	add: async ({ request }) => {
		const data = await request.formData();
		return attempt(() => {
			const person = recipientFrom(data, randomUUID());
			saveRecipients(database, [...readRecipients(database), person]);
			return noted(
				`Alerts: ${person.name} (${person.email}) was added`,
				`${person.name} is on the list.`
			);
		});
	},
	edit: async ({ request }) => {
		const data = await request.formData();
		const id = field(data, 'id');
		const current = readRecipients(database);
		if (!current.some((person) => person.id === id)) {
			return refused('That person is no longer on the list.', 404);
		}
		return attempt(() => {
			const person = recipientFrom(data, id);
			saveRecipients(
				database,
				current.map((existing) => (existing.id === id ? person : existing))
			);
			return noted(`Alerts: ${person.name}'s alerts were changed`, `Saved ${person.name}.`);
		});
	},
	remove: async ({ request }) => {
		const data = await request.formData();
		const id = field(data, 'id');
		const current = readRecipients(database);
		const person = current.find((existing) => existing.id === id);
		if (person === undefined) {
			return refused('That person is no longer on the list.', 404);
		}
		saveRecipients(
			database,
			current.filter((existing) => existing.id !== id)
		);
		return noted(
			`Alerts: ${person.name} (${person.email}) was removed`,
			`${person.name} gets no more alerts.`
		);
	},
	test: async ({ request }) => {
		const data = await request.formData();
		const person = readRecipients(database).find((existing) => existing.id === field(data, 'id'));
		if (person === undefined) {
			return refused('That person is no longer on the list.', 404);
		}
		const email = await alertService().sendTest(person, 'Someone using the console');
		if (email === null) {
			return refused('The test email went missing from the outbox.', 500);
		}
		switch (email.status) {
			case 'sent':
				return done(`Sent to ${email.address}. Check that it arrived.`);
			case 'not-sent':
				return refused(email.lastError ?? 'Email is not set up.');
			case 'queued':
			case 'failed':
				return refused(
					`Not sent: ${email.lastError ?? 'no reason given'}${email.status === 'queued' ? ' Lookstow tries again in a minute.' : ''}`
				);
		}
	}
} satisfies Actions;
