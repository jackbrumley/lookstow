import { hostname } from 'node:os';
import { ALERT_LABELS, type AlertType } from '../../../domain/alerts.ts';

/**
 * What an alert email looks like, after i12-pt6-control's: a greeting, the alert in short
 * paragraphs, where to look in the console, and why the person gets it. Emails carry no links:
 * the console opens only on the server, so they name the page to open there. Every value is
 * escaped in the HTML version (mailbox names and Microsoft's messages are not trusted).
 */
export type EmailSource = {
	alert: AlertType | null;
	title: string;
	/** Paragraphs, separated by blank lines. */
	body: string;
	/** The console page with more, by name ("Activity", "Mailboxes"). */
	page: string;
};

export type RenderedEmail = { subject: string; text: string; html: string };

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

const PARAGRAPH = 'margin:0 0 12px;line-height:1.5';

export function renderEmail(
	source: EmailSource,
	recipientName: string,
	server = hostname()
): RenderedEmail {
	const paragraphs = source.body
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== '');
	const look = `More is in the Lookstow console on ${server}, under ${source.page}.`;
	const why =
		source.alert === null
			? 'This is a test email, sent from the Alerts page.'
			: `You get this email because you are on the "${ALERT_LABELS[source.alert].label}" alert. Change that on the Alerts page.`;
	const footer = `Sent by Lookstow on ${server}. ${why}`;
	const text = [
		`Hi ${recipientName},`,
		'',
		...paragraphs.flatMap((paragraph) => [paragraph, '']),
		look,
		'',
		'--',
		footer
	].join('\n');
	const html = `<!doctype html>
<html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2328;max-width:680px">
<p style="${PARAGRAPH}">Hi ${escapeHtml(recipientName)},</p>
${paragraphs.map((paragraph) => `<p style="${PARAGRAPH}">${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`).join('\n')}
<p style="${PARAGRAPH};color:#59636e">${escapeHtml(look)}</p>
<hr style="border:none;border-top:1px solid #d0d7de;margin:20px 0 10px">
<p style="color:#59636e;font-size:12px;margin:0">${escapeHtml(footer)}</p>
</body></html>`;
	return { subject: `Lookstow: ${source.title}`, text, html };
}
