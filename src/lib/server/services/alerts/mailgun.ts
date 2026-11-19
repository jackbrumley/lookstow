import type { MailgunRegion } from '../../../domain/alerts.ts';
import type { MailgunSetup } from '../settings/settings.ts';

/**
 * Sending one email through Mailgun's HTTP API, as i12-pt6-control does. The key goes only to
 * Mailgun's own API host for the chosen region: the host is never taken from a setting.
 */
const HOSTS: Record<MailgunRegion, string> = {
	us: 'https://api.mailgun.net',
	eu: 'https://api.eu.mailgun.net'
};

/** How long one send may take before it counts as failed (and is tried again later). */
const SEND_TIMEOUT_MS = 30_000;

export type OutgoingEmail = { to: string; subject: string; text: string; html: string };

export type MailFetch = (url: string, init: RequestInit) => Promise<Response>;

class MailgunError extends Error {
	override name = 'MailgunError';
}

export async function sendMailgun(
	setup: MailgunSetup,
	email: OutgoingEmail,
	fetchImpl: MailFetch = fetch
): Promise<void> {
	let response: Response;
	try {
		response = await fetchImpl(
			`${HOSTS[setup.region]}/v3/${encodeURIComponent(setup.domain)}/messages`,
			{
				method: 'POST',
				headers: {
					authorization: `Basic ${Buffer.from(`api:${setup.apiKey}`).toString('base64')}`
				},
				body: new URLSearchParams({
					from: setup.from,
					to: email.to,
					subject: email.subject,
					text: email.text,
					html: email.html
				}),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
			}
		);
	} catch (error) {
		throw new MailgunError(
			`Could not reach Mailgun (${error instanceof Error ? error.message : String(error)})`,
			{ cause: error }
		);
	}
	if (!response.ok) {
		const answer = (await response.text().catch(() => '')).trim().slice(0, 300);
		const hint =
			response.status === 401
				? ' Check the sending key, and that the region matches your Mailgun account.'
				: response.status === 404
					? ' Check the sending domain, and that the region matches your Mailgun account.'
					: '';
		throw new MailgunError(
			`Mailgun refused it (${String(response.status)}${answer === '' ? '' : `: ${answer}`}).${hint}`
		);
	}
}
