/**
 * Reading Exchange's full-fidelity export (`.fts`), as the mailbox export API gives each online
 * archive item. A file is a list of records, each a 32-bit type, a 32-bit length and that many
 * bytes. Type 2 records, joined in order, hold the item as a FastTransfer stream (MS-OXCFXICS):
 * property tags and values, with markers around each recipient, attachment and attached message.
 * The other record types (1 and 4) are short headers Lookstow does not need.
 *
 * The reader is strict: a value that runs past the end of the data, an unknown property type or
 * an unbalanced marker is an error, never a silent misread.
 */

/** One property value: its type and raw bytes (one buffer per value for multi-valued types). */
export type FtsValue = { type: number; data: Buffer } | { type: number; values: Buffer[] };

type FtsNamedId = { guid: string; lid: number } | { guid: string; name: string };

export type FtsProperties = {
	/** Properties with ids below 0x8000, by id. */
	tagged: Map<number, FtsValue>;
	/** Named properties (ids from 0x8000), with the set and id or name that identify them. */
	named: { id: FtsNamedId; value: FtsValue }[];
};

export type FtsAttachment = { properties: FtsProperties; embedded: FtsMessage | null };

export type FtsMessage = {
	properties: FtsProperties;
	recipients: FtsProperties[];
	attachments: FtsAttachment[];
};

export class FtsError extends Error {
	override name = 'FtsError';
}

const RECORD_STREAM = 2;

const MARKER = {
	newAttach: 0x40000003,
	startEmbed: 0x40010003,
	endEmbed: 0x40020003,
	startRecip: 0x40030003,
	endToRecip: 0x40040003,
	startMessage: 0x400c0003,
	endMessage: 0x400d0003,
	endAttach: 0x400e0003
} as const;

/** Markers that carry no value, so the reader must not read one after them. */
const MARKERS = new Set<number>([
	...Object.values(MARKER),
	0x40090003, // StartTopFld
	0x400a0003, // StartSubFld
	0x400b0003, // EndFolder
	0x40100003 // StartFAIMsg
]);

/** Meta-properties between sections: a tag and a 32-bit value, outside any property list. */
const META_WITH_VALUE = new Set<number>([
	0x40160003, // MetaTagFXDelProp
	0x400f0003 // MetaTagEcWarning
]);

/** Sizes of the fixed-length property types. */
const FIXED_SIZES = new Map<number, number>([
	[0x0002, 2], // PtypInteger16
	[0x0003, 4], // PtypInteger32
	[0x0004, 4], // PtypFloating32
	[0x0005, 8], // PtypFloating64
	[0x0006, 8], // PtypCurrency
	[0x0007, 8], // PtypFloatingTime
	[0x000a, 4], // PtypErrorCode
	[0x000b, 2], // PtypBoolean (2 bytes in a FastTransfer stream)
	[0x0014, 8], // PtypInteger64
	[0x0040, 8], // PtypTime
	[0x0048, 16] // PtypGuid
]);

/** Variable-length types: a 32-bit length, then the bytes. */
const VARIABLE_TYPES = new Set<number>([
	0x000d, // PtypObject
	0x001e, // PtypString8
	0x001f, // PtypString (UTF-16LE)
	0x00fb, // PtypServerId
	0x0102 // PtypBinary
]);

const MULTI = 0x1000;
/** A string type with its code page in the low 15 bits (0x84B0 is UTF-16, code page 1200). */
const CODE_PAGE_STRING = 0x8000;

/** The FastTransfer stream inside an `.fts` file: every type 2 record, joined in order. */
function ftsStream(file: Buffer): Buffer {
	const parts: Buffer[] = [];
	let at = 0;
	while (at < file.length) {
		if (at + 8 > file.length) {
			throw new FtsError(`The file ends inside a record header at byte ${String(at)}`);
		}
		const type = file.readUInt32LE(at);
		const length = file.readUInt32LE(at + 4);
		const end = at + 8 + length;
		if (end > file.length) {
			throw new FtsError(`A record runs past the end of the file at byte ${String(at)}`);
		}
		if (type === RECORD_STREAM) {
			parts.push(file.subarray(at + 8, end));
		}
		at = end;
	}
	if (parts.length === 0) {
		throw new FtsError('The file holds no message data');
	}
	return Buffer.concat(parts);
}

class Cursor {
	at = 0;
	readonly #data: Buffer;

	constructor(data: Buffer) {
		this.#data = data;
	}

	get done(): boolean {
		return this.at >= this.#data.length;
	}

	#need(bytes: number): void {
		if (this.at + bytes > this.#data.length) {
			throw new FtsError(
				`The message data ends early: ${String(bytes)} bytes wanted at byte ${String(this.at)}`
			);
		}
	}

	u8(): number {
		this.#need(1);
		const value = this.#data.readUInt8(this.at);
		this.at += 1;
		return value;
	}

	u32(): number {
		this.#need(4);
		const value = this.#data.readUInt32LE(this.at);
		this.at += 4;
		return value;
	}

	peekU32(): number {
		this.#need(4);
		return this.#data.readUInt32LE(this.at);
	}

	bytes(count: number): Buffer {
		this.#need(count);
		const value = this.#data.subarray(this.at, this.at + count);
		this.at += count;
		return value;
	}

	/** A UTF-16LE string ending in a 16-bit zero (a named property's name). */
	utf16z(): string {
		const start = this.at;
		for (;;) {
			this.#need(2);
			const unit = this.#data.readUInt16LE(this.at);
			this.at += 2;
			if (unit === 0) {
				return this.#data.subarray(start, this.at - 2).toString('utf16le');
			}
		}
	}
}

function readValue(cursor: Cursor, type: number): Buffer {
	const size = FIXED_SIZES.get(type);
	if (size !== undefined) {
		return cursor.bytes(size);
	}
	if (VARIABLE_TYPES.has(type) || (type & CODE_PAGE_STRING) !== 0) {
		return cursor.bytes(cursor.u32());
	}
	throw new FtsError(`Unknown property type 0x${type.toString(16)} at byte ${String(cursor.at)}`);
}

function readNamedId(cursor: Cursor): FtsNamedId {
	const guid = guidText(cursor.bytes(16));
	const kind = cursor.u8();
	if (kind === 0) {
		return { guid, lid: cursor.u32() };
	}
	if (kind === 1) {
		return { guid, name: cursor.utf16z() };
	}
	throw new FtsError(`Unknown named property kind ${String(kind)} at byte ${String(cursor.at)}`);
}

/** A GUID in its usual text form, from its little-endian bytes. */
function guidText(bytes: Buffer): string {
	const hex = (from: number, to: number, reverse: boolean): string => {
		const part = [...bytes.subarray(from, to)];
		return (reverse ? part.reverse() : part)
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
	};
	return `${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10, false)}-${hex(10, 16, false)}`;
}

function emptyProperties(): FtsProperties {
	return { tagged: new Map(), named: [] };
}

/** Reads properties until the next marker (or the end), which is left unread. */
function readProperties(cursor: Cursor, into: FtsProperties): void {
	while (!cursor.done && !MARKERS.has(cursor.peekU32())) {
		const tag = cursor.u32();
		const type = tag & 0xffff;
		const id = tag >>> 16;
		const namedId = id >= 0x8000 ? readNamedId(cursor) : null;
		let value: FtsValue;
		if ((type & MULTI) !== 0) {
			const single = type & ~MULTI;
			const count = cursor.u32();
			const values: Buffer[] = [];
			for (let index = 0; index < count; index++) {
				values.push(readValue(cursor, single));
			}
			value = { type: single, values };
		} else {
			value = { type, data: readValue(cursor, type) };
		}
		if (namedId === null) {
			into.tagged.set(id, value);
		} else {
			into.named.push({ id: namedId, value });
		}
	}
}

function expect(cursor: Cursor, marker: number, what: string): void {
	const found = cursor.u32();
	if (found !== marker) {
		throw new FtsError(
			`Expected ${what} at byte ${String(cursor.at - 4)}, found 0x${found.toString(16)}`
		);
	}
}

/** A message's content: properties, then recipients, then attachments. */
function readMessageContent(cursor: Cursor): FtsMessage {
	const message: FtsMessage = {
		properties: emptyProperties(),
		recipients: [],
		attachments: []
	};
	readProperties(cursor, message.properties);
	while (!cursor.done) {
		const marker = cursor.peekU32();
		if (marker === MARKER.startRecip) {
			cursor.u32();
			const recipient = emptyProperties();
			readProperties(cursor, recipient);
			expect(cursor, MARKER.endToRecip, 'the end of a recipient');
			message.recipients.push(recipient);
		} else if (marker === MARKER.newAttach) {
			cursor.u32();
			message.attachments.push(readAttachment(cursor));
		} else if (marker === MARKER.startMessage) {
			// Some streams wrap the message itself in StartMessage and EndMessage.
			cursor.u32();
			readProperties(cursor, message.properties);
		} else if (marker === MARKER.endMessage) {
			cursor.u32();
		} else if (META_WITH_VALUE.has(marker)) {
			// MetaTagFXDelProp ("clear the recipients" or "the attachments" before sending them)
			// and MetaTagEcWarning: a 32-bit value each, nothing a reader keeps.
			cursor.u32();
			cursor.u32();
		} else {
			// EndEmbed and anything else end this message's content; the caller checks which.
			break;
		}
	}
	return message;
}

function readAttachment(cursor: Cursor): FtsAttachment {
	const properties = emptyProperties();
	readProperties(cursor, properties);
	let embedded: FtsMessage | null = null;
	if (!cursor.done && cursor.peekU32() === MARKER.startEmbed) {
		cursor.u32();
		embedded = readMessageContent(cursor);
		expect(cursor, MARKER.endEmbed, 'the end of an attached message');
		readProperties(cursor, properties);
	}
	expect(cursor, MARKER.endAttach, 'the end of an attachment');
	return { properties, embedded };
}

/** Reads one `.fts` file into its message, recipients and attachments. */
export function readFts(file: Buffer): FtsMessage {
	const cursor = new Cursor(ftsStream(file));
	const message = readMessageContent(cursor);
	if (!cursor.done) {
		throw new FtsError(
			`Unexpected marker 0x${cursor.peekU32().toString(16)} at byte ${String(cursor.at)}`
		);
	}
	return message;
}
