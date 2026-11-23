import { inflateRawSync, crc32 } from 'node:zlib';

/**
 * A small ZIP reader for the tests only: finds the central directory (ZIP64 too), and reads and
 * checks every file against its CRC, so the writer is tested by reading what it wrote.
 */
export type ZipFile = { name: string; data: Buffer; date: number; time: number };

export function readZip(zip: Buffer): { files: ZipFile[]; zip64: boolean } {
	const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (end < 0) throw new Error('No end of central directory');
	let count = zip.readUInt16LE(end + 10);
	let start = zip.readUInt32LE(end + 16);
	const zip64 = start === 0xffffffff || count === 0xffff;
	if (zip64) {
		const locator = end - 20;
		if (zip.readUInt32LE(locator) !== 0x07064b50) throw new Error('No ZIP64 locator');
		const end64 = Number(zip.readBigUInt64LE(locator + 8));
		if (zip.readUInt32LE(end64) !== 0x06064b50) throw new Error('No ZIP64 end record');
		count = Number(zip.readBigUInt64LE(end64 + 32));
		start = Number(zip.readBigUInt64LE(end64 + 48));
	}
	const files: ZipFile[] = [];
	let at = start;
	for (let index = 0; index < count; index += 1) {
		if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`No central header at ${String(at)}`);
		const method = zip.readUInt16LE(at + 10);
		const time = zip.readUInt16LE(at + 12);
		const date = zip.readUInt16LE(at + 14);
		const crc = zip.readUInt32LE(at + 16);
		const compressed = zip.readUInt32LE(at + 20);
		const nameLength = zip.readUInt16LE(at + 28);
		const extraLength = zip.readUInt16LE(at + 30);
		const commentLength = zip.readUInt16LE(at + 32);
		let offset = zip.readUInt32LE(at + 42);
		const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
		if (offset === 0xffffffff) {
			const extra = at + 46 + nameLength;
			if (zip.readUInt16LE(extra) !== 1) throw new Error('No ZIP64 extra field');
			offset = Number(zip.readBigUInt64LE(extra + 4));
		}
		if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`No local header for ${name}`);
		const dataAt = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
		const body = zip.subarray(dataAt, dataAt + compressed);
		const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
		if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
		files.push({ name, data, date, time });
		at += 46 + nameLength + extraLength + commentLength;
	}
	return { files, zip64 };
}
