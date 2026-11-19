import { describe, expect, it } from 'vitest';
import {
	MARK,
	attachment,
	bin,
	bool,
	ftsFile,
	int,
	marker,
	namedStrings,
	namedTime,
	recipient,
	str,
	time
} from '#tests/support/fts-builder.ts';
import { toEml, encodeHeaderText } from './fts-eml.ts';
import { APPOINTMENT, APPOINTMENT_SET, PROP, summarise } from './fts-properties.ts';
import { FtsError, readFts } from './fts-reader.ts';

const RECEIVED = Date.parse('2018-08-27T03:04:05Z');
const SENT = Date.parse('2018-08-27T03:04:00Z');
const PUBLIC_STRINGS = '00020329-0000-0000-c000-000000000046';

/** An invented email: HTML with an inline image, a PDF, and an attached message. */
function email(): Buffer {
	const html = Buffer.from(
		'<html><body><p>Café report</p><img src="cid:logo@x"></body></html>',
		'utf8'
	);
	const inner = Buffer.concat([
		str(PROP.messageClass, 'IPM.Note'),
		str(PROP.subject, 'Original: été'),
		str(PROP.senderSmtpAddress, 'old@example.com'),
		str(PROP.body, 'The first message.')
	]);
	return Buffer.concat([
		str(PROP.messageClass, 'IPM.Note'),
		str(PROP.subject, 'Café report: "Q3"'),
		time(PROP.clientSubmitTime, SENT),
		time(PROP.messageDeliveryTime, RECEIVED),
		str(PROP.senderName, 'Ann Example'),
		str(PROP.senderAddressType, 'EX'),
		str(PROP.senderEmailAddress, '/o=Org/cn=ann'),
		str(PROP.senderSmtpAddress, 'Ann@Example.com'),
		str(PROP.internetMessageId, '<m1@example.com>'),
		int(PROP.internetCodepage, 65001),
		bin(PROP.html, html),
		namedStrings(PUBLIC_STRINGS, 'Keywords', 0x8001, ['one', 'two']),
		marker(MARK.delProp),
		Buffer.from([0x00, 0x00, 0x12, 0x0e]),
		recipient(
			int(PROP.recipientType, 1),
			str(PROP.displayName, 'Bob'),
			str(PROP.addressType, 'EX'),
			str(PROP.emailAddress, '/o=Org/cn=bob'),
			str(PROP.smtpAddress, 'Bob@Example.com')
		),
		recipient(
			int(PROP.recipientType, 2),
			str(PROP.displayName, 'Cat'),
			str(PROP.addressType, 'SMTP'),
			str(PROP.emailAddress, 'cat@example.com')
		),
		recipient(int(PROP.recipientType, 3), str(PROP.smtpAddress, 'hidden@example.com')),
		marker(MARK.delProp),
		Buffer.from([0x00, 0x00, 0x13, 0x0e]),
		attachment([
			int(PROP.attachMethod, 1),
			str(PROP.attachLongFilename, 'logo.png'),
			str(PROP.attachMimeTag, 'image/png'),
			str(PROP.attachContentId, 'logo@x'),
			bool(0x7ffe, true),
			bin(PROP.attachData, Buffer.from('PNGDATA'))
		]),
		attachment([
			int(PROP.attachMethod, 1),
			str(PROP.attachLongFilename, 'Q3: report?.pdf'),
			str(PROP.attachMimeTag, 'application/pdf'),
			bin(PROP.attachData, Buffer.from('%PDF-1.4 data'))
		]),
		attachment([int(PROP.attachMethod, 5), str(PROP.displayName, 'RE: original')], inner)
	]);
}

describe('reading an .fts file', () => {
	it('reads properties, recipients, attachments and an attached message across records', () => {
		const message = readFts(ftsFile(email(), 37));
		expect(message.recipients).toHaveLength(3);
		expect(message.attachments).toHaveLength(3);
		expect(message.attachments[2]?.embedded?.properties.tagged.size).toBeGreaterThan(0);
		expect(message.properties.named[0]?.id).toEqual({ guid: PUBLIC_STRINGS, name: 'Keywords' });
	});

	it('gives Search the same fields as normal mail', () => {
		expect(summarise(readFts(ftsFile(email())))).toEqual({
			subject: 'Café report: "Q3"',
			sender: 'Ann@Example.com',
			recipients: ['bob@example.com', 'cat@example.com'],
			receivedAt: RECEIVED,
			internetMessageId: '<m1@example.com>'
		});
	});

	it('refuses a file that ends early or holds an unknown type, instead of misreading it', () => {
		const whole = email();
		expect(() => readFts(ftsFile(whole.subarray(0, whole.length - 3)))).toThrow(FtsError);
		const unknown = Buffer.concat([Buffer.from([0x99, 0x00, 0x37, 0x00]), Buffer.alloc(8)]);
		expect(() => readFts(ftsFile(unknown))).toThrow(/Unknown property type 0x99/);
		expect(() => readFts(Buffer.from([1, 0, 0, 0, 8, 0, 0, 0]))).toThrow(FtsError);
	});
});

describe('an .fts message as .eml', () => {
	const eml = toEml(readFts(ftsFile(email()))).toString('latin1');

	it('writes the headers, encoding text that is not ASCII', () => {
		expect(eml).toContain('From: "Ann Example" <Ann@Example.com>\r\n');
		expect(eml).toContain('To: "Bob" <Bob@Example.com>\r\n');
		expect(eml).toContain('Cc: "Cat" <cat@example.com>\r\n');
		expect(eml).toContain('Bcc: <hidden@example.com>\r\n');
		expect(eml).toContain(`Subject: ${encodeHeaderText('Café report: "Q3"')}\r\n`);
		expect(eml).toContain('Date: Mon, 27 Aug 2018 03:04:00 +0000\r\n');
		expect(eml).toContain('Message-ID: <m1@example.com>\r\n');
		expect(encodeHeaderText('Café')).toBe(`=?UTF-8?B?${Buffer.from('Café').toString('base64')}?=`);
	});

	it('keeps the inline image with the HTML and attaches every other part', () => {
		expect(eml).toMatch(/Content-Type: multipart\/mixed;/);
		expect(eml).toMatch(/Content-Type: multipart\/related;/);
		expect(eml).toContain('Content-ID: <logo@x>');
		expect(eml).toContain('Content-Disposition: inline; filename="logo.png"');
		// A name Windows cannot save is made safe; the attachment itself is unchanged.
		expect(eml).toContain('filename="Q3_ report_.pdf"');
		expect(eml).toContain(Buffer.from('%PDF-1.4 data').toString('base64'));
		expect(eml).toContain('Content-Type: message/rfc822; name="RE_ original.eml"');
		expect(eml).toContain(`Subject: ${encodeHeaderText('Original: été')}`);
		const html =
			/Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(
				eml
			);
		expect(
			Buffer.from((html?.[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8')
		).toContain('Café report');
	});

	it('gives an appointment without a body its start, end and place', () => {
		const start = Date.parse('2024-02-05T06:50:00Z');
		const appointment = toEml(
			readFts(
				ftsFile(
					Buffer.concat([
						str(PROP.messageClass, 'IPM.Appointment'),
						str(PROP.subject, 'Planning'),
						namedTime(APPOINTMENT_SET, APPOINTMENT.start, 0x8010, start),
						namedTime(APPOINTMENT_SET, APPOINTMENT.end, 0x8011, start + 3_600_000)
					])
				)
			)
		).toString('latin1');
		expect(appointment).toContain('X-Lookstow-Appointment-Start: 2024-02-05T06:50:00.000Z');
		const body = /base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)$/.exec(appointment);
		expect(Buffer.from((body?.[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
			'Start: 2024-02-05T06:50:00.000Z\r\nEnd: 2024-02-05T07:50:00.000Z'
		);
	});
});
