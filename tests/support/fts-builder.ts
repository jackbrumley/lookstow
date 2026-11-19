/**
 * Builds invented `.fts` files for tests, in the layout Exchange's export uses: record 1 and 4
 * headers, then the FastTransfer stream in type 2 records (split, as Exchange splits it). Tests
 * never use real mail.
 */
export const PT = {
	int32: 0x0003,
	boolean: 0x000b,
	time: 0x0040,
	binary: 0x0102,
	unicode: 0x84b0
} as const;

export const MARK = {
	startRecip: 0x40030003,
	endToRecip: 0x40040003,
	newAttach: 0x40000003,
	endAttach: 0x400e0003,
	startEmbed: 0x40010003,
	endEmbed: 0x40020003,
	delProp: 0x40160003
} as const;

function u32(value: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value >>> 0, 0);
	return buffer;
}

function tag(id: number, type: number): Buffer {
	return u32(((id << 16) | type) >>> 0);
}

/** A UTF-16 string property (code page 1200), with its terminating zero. */
export function str(id: number, value: string): Buffer {
	const data = Buffer.from(`${value}\0`, 'utf16le');
	return Buffer.concat([tag(id, PT.unicode), u32(data.length), data]);
}

export function int(id: number, value: number): Buffer {
	return Buffer.concat([tag(id, PT.int32), u32(value)]);
}

export function bool(id: number, value: boolean): Buffer {
	return Buffer.concat([tag(id, PT.boolean), Buffer.from([value ? 1 : 0, 0])]);
}

export function bin(id: number, data: Buffer): Buffer {
	return Buffer.concat([tag(id, PT.binary), u32(data.length), data]);
}

/** A FILETIME property from milliseconds since 1970. */
export function time(id: number, ms: number): Buffer {
	const value = Buffer.alloc(8);
	value.writeBigUInt64LE((BigInt(ms) + 11_644_473_600_000n) * 10_000n, 0);
	return Buffer.concat([tag(id, PT.time), value]);
}

function guidBytes(guid: string): Buffer {
	const hex = guid.replaceAll('-', '');
	const part = (from: number, to: number, reverse: boolean): number[] => {
		const bytes = [...Buffer.from(hex.slice(from, to), 'hex')];
		return reverse ? bytes.reverse() : bytes;
	};
	return Buffer.from([
		...part(0, 8, true),
		...part(8, 12, true),
		...part(12, 16, true),
		...part(16, 32, false)
	]);
}

/** A named property by set and numeric id, holding a FILETIME. */
export function namedTime(guid: string, lid: number, id: number, ms: number): Buffer {
	const value = Buffer.alloc(8);
	value.writeBigUInt64LE((BigInt(ms) + 11_644_473_600_000n) * 10_000n, 0);
	return Buffer.concat([tag(id, PT.time), guidBytes(guid), Buffer.from([0]), u32(lid), value]);
}

/** A named property by set and name, holding several UTF-16 strings (type 0x94B0). */
export function namedStrings(guid: string, name: string, id: number, values: string[]): Buffer {
	const encoded = values.map((value) => Buffer.from(`${value}\0`, 'utf16le'));
	return Buffer.concat([
		tag(id, PT.unicode | 0x1000),
		guidBytes(guid),
		Buffer.from([1]),
		Buffer.from(`${name}\0`, 'utf16le'),
		u32(values.length),
		...encoded.flatMap((value) => [u32(value.length), value])
	]);
}

export function marker(value: number): Buffer {
	return u32(value);
}

export function recipient(...properties: Buffer[]): Buffer {
	return Buffer.concat([marker(MARK.startRecip), ...properties, marker(MARK.endToRecip)]);
}

export function attachment(properties: Buffer[], embedded?: Buffer): Buffer {
	return Buffer.concat([
		marker(MARK.newAttach),
		...properties,
		...(embedded === undefined ? [] : [marker(MARK.startEmbed), embedded, marker(MARK.endEmbed)]),
		marker(MARK.endAttach)
	]);
}

/** A whole `.fts` file around a stream, split into type 2 records of `chunk` bytes. */
export function ftsFile(stream: Buffer, chunk = 64): Buffer {
	const records: Buffer[] = [u32(1), u32(8), Buffer.alloc(8), u32(4), u32(6), Buffer.alloc(6)];
	for (let at = 0; at < stream.length; at += chunk) {
		const part = stream.subarray(at, at + chunk);
		records.push(u32(2), u32(part.length), part);
	}
	return Buffer.concat(records);
}
