import type { FtsMessage, FtsProperties, FtsValue } from './fts-reader.ts';

/**
 * Typed reads of the MAPI properties in an `.fts` message: text in whatever code page it was
 * stored in, times, numbers and bytes. Property ids are MS-OXPROPS's; named properties are
 * found by their property set and id.
 */
export const PROP = {
	messageClass: 0x001a,
	subject: 0x0037,
	clientSubmitTime: 0x0039,
	sentRepresentingName: 0x0042,
	transportHeaders: 0x007d,
	recipientType: 0x0c15,
	senderName: 0x0c1a,
	senderAddressType: 0x0c1e,
	senderEmailAddress: 0x0c1f,
	messageDeliveryTime: 0x0e06,
	body: 0x1000,
	html: 0x1013,
	internetMessageId: 0x1035,
	inReplyTo: 0x1042,
	displayName: 0x3001,
	addressType: 0x3002,
	emailAddress: 0x3003,
	attachData: 0x3701,
	attachFilename: 0x3704,
	attachMethod: 0x3705,
	attachLongFilename: 0x3707,
	attachMimeTag: 0x370e,
	attachContentId: 0x3712,
	internetCodepage: 0x3fde,
	smtpAddress: 0x39fe,
	senderSmtpAddress: 0x5d01,
	sentRepresentingSmtpAddress: 0x5d02
} as const;

/** The appointment property set (PSETID_Appointment) and the ids Lookstow shows. */
export const APPOINTMENT_SET = '00062002-0000-0000-c000-000000000046';
export const APPOINTMENT = { location: 0x8208, start: 0x820d, end: 0x820e } as const;

const PTYP_STRING8 = 0x001e;
const PTYP_UNICODE = 0x001f;
const CODE_PAGE_STRING = 0x8000;

/** Windows code pages Lookstow can decode, by number, as TextDecoder labels. */
const CODE_PAGES = new Map<number, string>([
	[1200, 'utf-16le'],
	[1201, 'utf-16be'],
	[65001, 'utf-8'],
	[20127, 'us-ascii'],
	[28591, 'iso-8859-1'],
	[28592, 'iso-8859-2'],
	[28595, 'iso-8859-5'],
	[28597, 'iso-8859-7'],
	[28605, 'iso-8859-15'],
	[1250, 'windows-1250'],
	[1251, 'windows-1251'],
	[1252, 'windows-1252'],
	[1253, 'windows-1253'],
	[1254, 'windows-1254'],
	[1255, 'windows-1255'],
	[1256, 'windows-1256'],
	[1257, 'windows-1257'],
	[1258, 'windows-1258'],
	[874, 'windows-874'],
	[932, 'shift_jis'],
	[936, 'gbk'],
	[949, 'euc-kr'],
	[950, 'big5'],
	[50220, 'iso-2022-jp'],
	[51932, 'euc-jp'],
	[54936, 'gb18030'],
	[20866, 'koi8-r']
]);

/** Decodes bytes stored in a Windows code page; unknown pages are read as UTF-8. */
export function decodeCodePage(bytes: Buffer, codePage: number): string {
	const label = CODE_PAGES.get(codePage) ?? 'utf-8';
	return new TextDecoder(label).decode(bytes);
}

function single(value: FtsValue | undefined): { type: number; data: Buffer } | undefined {
	return value !== undefined && 'data' in value ? value : undefined;
}

/** A string value as text, without the terminating zero. */
export function valueText(value: FtsValue | undefined): string | null {
	const found = single(value);
	if (found === undefined) return null;
	let text: string;
	if (found.type === PTYP_UNICODE) {
		text = found.data.toString('utf16le');
	} else if ((found.type & CODE_PAGE_STRING) !== 0) {
		text = decodeCodePage(found.data, found.type & 0x7fff);
	} else if (found.type === PTYP_STRING8) {
		text = decodeCodePage(found.data, 1252);
	} else {
		return null;
	}
	return text.replace(/\0+$/, '');
}

export function text(properties: FtsProperties, id: number): string | null {
	return valueText(properties.tagged.get(id));
}

export function int32(properties: FtsProperties, id: number): number | null {
	const found = single(properties.tagged.get(id));
	return found?.data.length === 4 ? found.data.readInt32LE(0) : null;
}

export function bytes(properties: FtsProperties, id: number): Buffer | null {
	return single(properties.tagged.get(id))?.data ?? null;
}

/** Milliseconds since 1601 to 1970, for Windows FILETIME values. */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;

export function filetime(data: Buffer | null | undefined): number | null {
	if (data?.length !== 8) return null;
	const ticks = data.readBigUInt64LE(0);
	if (ticks === 0n) return null;
	return Number(ticks / 10_000n - FILETIME_EPOCH_MS);
}

export function time(properties: FtsProperties, id: number): number | null {
	return filetime(bytes(properties, id));
}

export function namedValue(
	properties: FtsProperties,
	guid: string,
	lid: number
): FtsValue | undefined {
	return properties.named.find(
		(entry) => entry.id.guid === guid && 'lid' in entry.id && entry.id.lid === lid
	)?.value;
}

/** An address as `Name <address>` parts, preferring the SMTP address. */
export type Mailbox = { name: string; address: string };

function smtpOrNull(address: string | null, type: string | null): string | null {
	if (address === null || address === '') return null;
	return type === null || type.toUpperCase() === 'SMTP' ? address : null;
}

export function sender(message: FtsMessage): Mailbox | null {
	const properties = message.properties;
	const address =
		text(properties, PROP.senderSmtpAddress) ??
		smtpOrNull(
			text(properties, PROP.senderEmailAddress),
			text(properties, PROP.senderAddressType)
		) ??
		text(properties, PROP.sentRepresentingSmtpAddress);
	const name =
		text(properties, PROP.senderName) ?? text(properties, PROP.sentRepresentingName) ?? '';
	if ((address === null || address === '') && name === '') return null;
	return { name, address: address ?? '' };
}

export type Recipient = Mailbox & { kind: 'to' | 'cc' | 'bcc' };

export function recipients(message: FtsMessage): Recipient[] {
	return message.recipients.map((properties) => {
		const type = int32(properties, PROP.recipientType) ?? 1;
		const kind = type === 2 ? 'cc' : type === 3 ? 'bcc' : 'to';
		const address =
			text(properties, PROP.smtpAddress) ??
			smtpOrNull(text(properties, PROP.emailAddress), text(properties, PROP.addressType)) ??
			'';
		return { kind, name: text(properties, PROP.displayName) ?? '', address };
	});
}

/** What Search needs from an archive item: the same fields normal mail stores. */
export type FtsSummary = {
	subject: string;
	sender: string;
	/** To and Cc addresses, lower case. */
	recipients: string[];
	receivedAt: number | null;
	internetMessageId: string | null;
};

export function summarise(message: FtsMessage): FtsSummary {
	const properties = message.properties;
	const from = sender(message);
	return {
		subject: text(properties, PROP.subject) ?? '',
		sender: from === null ? '' : from.address !== '' ? from.address : from.name,
		recipients: recipients(message)
			.filter((recipient) => recipient.kind !== 'bcc' && recipient.address !== '')
			.map((recipient) => recipient.address.toLowerCase()),
		receivedAt:
			time(properties, PROP.messageDeliveryTime) ?? time(properties, PROP.clientSubmitTime),
		internetMessageId: text(properties, PROP.internetMessageId)
	};
}
