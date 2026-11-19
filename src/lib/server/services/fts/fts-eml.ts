import { randomBytes } from 'node:crypto';
import { safeSegment } from '../storage/eml-store.ts';
import type { FtsAttachment, FtsMessage } from './fts-reader.ts';
import {
	APPOINTMENT,
	APPOINTMENT_SET,
	PROP,
	bytes,
	decodeCodePage,
	filetime,
	int32,
	namedValue,
	recipients,
	sender,
	text,
	time,
	valueText,
	type Mailbox
} from './fts-properties.ts';

/**
 * An `.fts` message as a standard `.eml` (RFC 5322 and MIME) that any mail program opens: the
 * headers, the body (HTML or plain text, re-encoded as UTF-8), inline images beside the HTML,
 * attachments, and attached messages as `message/rfc822`, converted the same way. The `.fts` file
 * stays the record; this is a readable copy made from it, and says so in a header.
 */
const CRLF = '\r\n';
const LINE = 76;

const ATTACH_BY_VALUE = 1;
const ATTACH_EMBEDDED_MESSAGE = 5;

function boundary(): string {
	return `----=_Lookstow_${randomBytes(12).toString('hex')}`;
}

/** Header text on one line: line breaks and other control characters become spaces. */
function oneLine(value: string): string {
	let line = '';
	for (const character of value) {
		line += character.charCodeAt(0) < 0x20 || character === '\x7f' ? ' ' : character;
	}
	return line.trim();
}

const PLAIN_HEADER = /^[\x20-\x7e]*$/;

/** RFC 2047 encoded words for non-ASCII header text, split so no word passes 75 characters. */
export function encodeHeaderText(value: string): string {
	const line = oneLine(value);
	if (PLAIN_HEADER.test(line)) return line;
	const words: string[] = [];
	let chunk = '';
	for (const character of line) {
		if (Buffer.byteLength(chunk + character) > 45) {
			words.push(chunk);
			chunk = '';
		}
		chunk += character;
	}
	if (chunk !== '') words.push(chunk);
	return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join(' ');
}

function encodeMailbox(mailbox: Mailbox): string {
	const address = oneLine(mailbox.address);
	const name = oneLine(mailbox.name);
	if (name === '' || name === address) return address === '' ? '' : `<${address}>`;
	const shown = PLAIN_HEADER.test(name)
		? `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
		: encodeHeaderText(name);
	return address === '' ? shown : `${shown} <${address}>`;
}

function rfc5322Date(ms: number): string {
	return new Date(ms).toUTCString().replace(/GMT$/, '+0000');
}

function base64Lines(data: Buffer): string {
	const encoded = data.toString('base64');
	const lines: string[] = [];
	for (let at = 0; at < encoded.length; at += LINE) {
		lines.push(encoded.slice(at, at + LINE));
	}
	return lines.join(CRLF);
}

function quotedParameter(value: string): string {
	return `"${oneLine(value).replaceAll('\\', '_').replaceAll('"', '_')}"`;
}

/** `name="ascii"; name*=UTF-8''exact` (RFC 2231), so every mail program finds a usable name. */
function nameParameters(parameter: string, value: string): string {
	const ascii = oneLine(value).replace(/[^\x20-\x7e]/g, '_');
	const exact = encodeURIComponent(oneLine(value)).replace(
		/['()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return `${parameter}=${quotedParameter(ascii)}; ${parameter}*=UTF-8''${exact}`;
}

type Part = { headers: string[]; body: string };

function render(part: Part): string {
	return `${part.headers.join(CRLF)}${CRLF}${CRLF}${part.body}`;
}

function multipart(subtype: string, parts: Part[]): Part {
	const mark = boundary();
	const body =
		parts.map((part) => `--${mark}${CRLF}${render(part)}${CRLF}`).join('') + `--${mark}--`;
	return { headers: [`Content-Type: multipart/${subtype}; boundary="${mark}"`], body };
}

function textPart(subtype: 'plain' | 'html', content: string): Part {
	return {
		headers: [`Content-Type: text/${subtype}; charset=utf-8`, 'Content-Transfer-Encoding: base64'],
		body: base64Lines(Buffer.from(content, 'utf8'))
	};
}

/** An attachment's file name, safe to save on Windows and Linux (the stored name is kept). */
function attachmentName(attachment: FtsAttachment, fallback: string): string {
	const properties = attachment.properties;
	const name =
		text(properties, PROP.attachLongFilename) ??
		text(properties, PROP.attachFilename) ??
		text(properties, PROP.displayName) ??
		fallback;
	return safeSegment(name === '' ? fallback : name, 200);
}

/** Appointment details, for calendar items: when, until when, and where (label and value). */
function appointmentDetails(message: FtsMessage): [string, string][] {
	const properties = message.properties;
	const at = (lid: number): number | null => {
		const value = namedValue(properties, APPOINTMENT_SET, lid);
		return value !== undefined && 'data' in value ? filetime(value.data) : null;
	};
	const start = at(APPOINTMENT.start);
	const end = at(APPOINTMENT.end);
	const location = valueText(namedValue(properties, APPOINTMENT_SET, APPOINTMENT.location));
	const details: [string, string][] = [];
	if (start !== null) details.push(['Start', new Date(start).toISOString()]);
	if (end !== null) details.push(['End', new Date(end).toISOString()]);
	if (location !== null && location !== '') details.push(['Location', location]);
	return details;
}

function bodyContent(message: FtsMessage): { html: string | null; plain: string | null } {
	const properties = message.properties;
	const html = bytes(properties, PROP.html);
	const codePage = int32(properties, PROP.internetCodepage) ?? 65001;
	return {
		html: html === null || html.length === 0 ? null : decodeCodePage(html, codePage),
		plain: text(properties, PROP.body)
	};
}

function attachmentPart(attachment: FtsAttachment, index: number, inline: boolean): Part | null {
	const properties = attachment.properties;
	const method = int32(properties, PROP.attachMethod) ?? ATTACH_BY_VALUE;
	if (method === ATTACH_EMBEDDED_MESSAGE && attachment.embedded !== null) {
		const name = `${attachmentName(attachment, `attached message ${String(index + 1)}`)}.eml`;
		const nested = toEml(attachment.embedded);
		const ascii = nested.every((byte) => byte < 0x80);
		return {
			headers: [
				`Content-Type: message/rfc822; ${nameParameters('name', name)}`,
				`Content-Transfer-Encoding: ${ascii ? '7bit' : '8bit'}`,
				`Content-Disposition: attachment; ${nameParameters('filename', name)}`
			],
			body: nested.toString(ascii ? 'ascii' : 'latin1')
		};
	}
	const data = bytes(properties, PROP.attachData);
	if (data === null) return null;
	const name = attachmentName(attachment, `attachment ${String(index + 1)}`);
	const mime = oneLine(text(properties, PROP.attachMimeTag) ?? 'application/octet-stream');
	const contentId = text(properties, PROP.attachContentId);
	const headers = [
		`Content-Type: ${/^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream'}; ${nameParameters('name', name)}`,
		'Content-Transfer-Encoding: base64',
		`Content-Disposition: ${inline ? 'inline' : 'attachment'}; ${nameParameters('filename', name)}`
	];
	if (contentId !== null && contentId !== '') {
		headers.push(`Content-ID: <${oneLine(contentId).replace(/^<|>$/g, '')}>`);
	}
	return { headers, body: base64Lines(data) };
}

/** The message as `.eml` bytes. */
export function toEml(message: FtsMessage): Buffer {
	const properties = message.properties;
	const headers: string[] = [];
	const from = sender(message);
	if (from !== null) headers.push(`From: ${encodeMailbox(from)}`);
	const people = recipients(message);
	for (const [kind, header] of [
		['to', 'To'],
		['cc', 'Cc'],
		['bcc', 'Bcc']
	] as const) {
		const list = people
			.filter((person) => person.kind === kind)
			.map(encodeMailbox)
			.filter((entry) => entry !== '');
		if (list.length > 0) headers.push(`${header}: ${list.join(`,${CRLF} `)}`);
	}
	headers.push(`Subject: ${encodeHeaderText(text(properties, PROP.subject) ?? '')}`);
	const sent =
		time(properties, PROP.clientSubmitTime) ?? time(properties, PROP.messageDeliveryTime);
	if (sent !== null) headers.push(`Date: ${rfc5322Date(sent)}`);
	const messageId = text(properties, PROP.internetMessageId);
	if (messageId !== null && messageId !== '') headers.push(`Message-ID: ${oneLine(messageId)}`);
	const inReplyTo = text(properties, PROP.inReplyTo);
	if (inReplyTo !== null && inReplyTo !== '') headers.push(`In-Reply-To: ${oneLine(inReplyTo)}`);
	headers.push('MIME-Version: 1.0');
	const messageClass = text(properties, PROP.messageClass);
	if (messageClass !== null) headers.push(`X-MS-Message-Class: ${oneLine(messageClass)}`);
	const appointment = appointmentDetails(message);
	for (const [label, value] of appointment) {
		headers.push(`X-Lookstow-Appointment-${label}: ${encodeHeaderText(value)}`);
	}
	headers.push(
		'X-Lookstow-Converted-From: Exchange full-fidelity export (.fts) of an online archive item'
	);

	const { html, plain } = bodyContent(message);
	// Inline images go beside the HTML that shows them; every other attachment, hidden or not, is
	// attached, so nothing in the item is left out of its readable copy.
	const inline =
		html === null
			? []
			: message.attachments.filter((attachment) => {
					const id = text(attachment.properties, PROP.attachContentId);
					return id !== null && id !== '' && html.includes(`cid:${id.replace(/^<|>$/g, '')}`);
				});
	let body: Part;
	if (html !== null) {
		const htmlPart = textPart('html', html);
		const inlineParts = inline
			.map((attachment) =>
				attachmentPart(attachment, message.attachments.indexOf(attachment), true)
			)
			.filter((part) => part !== null);
		body = inlineParts.length > 0 ? multipart('related', [htmlPart, ...inlineParts]) : htmlPart;
	} else {
		const fallback = appointment.map(([label, value]) => `${label}: ${value}`).join(CRLF);
		body = textPart('plain', plain ?? fallback);
	}
	const attached = message.attachments
		.filter((attachment) => !inline.includes(attachment))
		.map((attachment) => attachmentPart(attachment, message.attachments.indexOf(attachment), false))
		.filter((part) => part !== null);
	const top = attached.length > 0 ? multipart('mixed', [body, ...attached]) : body;
	return Buffer.from(`${headers.join(CRLF)}${CRLF}${render(top)}${CRLF}`, 'latin1');
}
