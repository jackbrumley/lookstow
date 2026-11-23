import { createHash, type Hash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';

/**
 * A ZIP file written front to back to disk (docs/specs/SPEC-EVIDENCE-PACKS.md): each file is
 * compressed and written as it comes, so a pack of many gigabytes never sits in memory. Files are
 * deflated, or stored when that is no smaller. Names are UTF-8. The archive becomes ZIP64 only
 * where it must (an offset past 4 GB, or more than 65,535 files), which Windows Explorer, macOS,
 * 7-Zip and unzip all read. One file inside is at most 4 GB; an email never comes near that.
 * The SHA-256 of the whole archive is worked out while it is written.
 */
const deflate = promisify(deflateRaw);

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const END_64 = 0x06064b50;
const END_64_LOCATOR = 0x07064b50;
const END = 0x06054b50;
/** Bit 3: sizes follow the data; bit 11: the name is UTF-8. */
const FLAGS = 0x0808;
const MAX_32 = 0xffffffff;
const MAX_16 = 0xffff;

type Entry = {
	name: Buffer;
	method: 0 | 8;
	crc: number;
	compressed: number;
	size: number;
	offset: number;
	time: number;
	date: number;
};

/** The DOS date and time a ZIP keeps (local time, two-second steps, 1980 at the earliest). */
export function dosDateTime(when: Date): { date: number; time: number } {
	const year = when.getFullYear();
	if (year < 1980) return { date: (0 << 9) | (1 << 5) | 1, time: 0 };
	return {
		date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
		time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2)
	};
}

export type ZipLimits = { offset: number; entries: number };

export class ZipWriter {
	readonly #file: FileHandle;
	readonly #hash: Hash = createHash('sha256');
	readonly #entries: Entry[] = [];
	readonly #limits: ZipLimits;
	#position = 0;
	#closed = false;

	private constructor(file: FileHandle, limits: ZipLimits) {
		this.#file = file;
		this.#limits = limits;
	}

	/** `limits` lowers where ZIP64 starts, for tests only. */
	static async create(
		path: string,
		limits: ZipLimits = { offset: MAX_32, entries: MAX_16 }
	): Promise<ZipWriter> {
		return new ZipWriter(await open(path, 'wx', 0o600), limits);
	}

	/** Bytes written so far. */
	get bytes(): number {
		return this.#position;
	}

	async #write(data: Buffer): Promise<void> {
		let done = 0;
		while (done < data.length) {
			const { bytesWritten } = await this.#file.write(data, done, data.length - done, null);
			done += bytesWritten;
		}
		this.#hash.update(data);
		this.#position += data.length;
	}

	/** Adds one file. `name` uses forward slashes, with no leading slash. */
	async add(name: string, data: Buffer, modified: Date): Promise<void> {
		if (this.#closed) throw new Error('The ZIP file is already finished');
		if (data.length >= MAX_32) throw new Error(`${name} is 4 GB or more`);
		const nameBytes = Buffer.from(name, 'utf8');
		if (nameBytes.length > MAX_16) throw new Error(`The name ${name.slice(0, 40)}… is too long`);
		const packed = await deflate(data, { level: 6 });
		const method = packed.length < data.length ? 8 : 0;
		const body = method === 8 ? packed : data;
		const { date, time } = dosDateTime(modified);
		const entry: Entry = {
			name: nameBytes,
			method,
			crc: crc32(data),
			compressed: body.length,
			size: data.length,
			offset: this.#position,
			time,
			date
		};
		const header = Buffer.alloc(30);
		header.writeUInt32LE(LOCAL_HEADER, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(FLAGS, 6);
		header.writeUInt16LE(method, 8);
		header.writeUInt16LE(time, 10);
		header.writeUInt16LE(date, 12);
		// CRC and sizes are 0 here and follow the data (bit 3).
		header.writeUInt16LE(nameBytes.length, 26);
		header.writeUInt16LE(0, 28);
		await this.#write(Buffer.concat([header, nameBytes]));
		await this.#write(body);
		const descriptor = Buffer.alloc(16);
		descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
		descriptor.writeUInt32LE(entry.crc, 4);
		descriptor.writeUInt32LE(entry.compressed, 8);
		descriptor.writeUInt32LE(entry.size, 12);
		await this.#write(descriptor);
		this.#entries.push(entry);
	}

	/** Writes the central directory and closes the file; returns its size and SHA-256. */
	async finish(): Promise<{ bytes: number; sha256: string; entries: number }> {
		if (this.#closed) throw new Error('The ZIP file is already finished');
		this.#closed = true;
		try {
			const start = this.#position;
			for (const entry of this.#entries) await this.#write(this.#central(entry));
			const size = this.#position - start;
			const count = this.#entries.length;
			const zip64 =
				start >= this.#limits.offset ||
				size >= this.#limits.offset ||
				count >= this.#limits.entries;
			if (zip64) {
				const end64At = this.#position;
				const end64 = Buffer.alloc(56);
				end64.writeUInt32LE(END_64, 0);
				end64.writeBigUInt64LE(44n, 4);
				end64.writeUInt16LE(45, 12);
				end64.writeUInt16LE(45, 14);
				end64.writeBigUInt64LE(BigInt(count), 24);
				end64.writeBigUInt64LE(BigInt(count), 32);
				end64.writeBigUInt64LE(BigInt(size), 40);
				end64.writeBigUInt64LE(BigInt(start), 48);
				const locator = Buffer.alloc(20);
				locator.writeUInt32LE(END_64_LOCATOR, 0);
				locator.writeBigUInt64LE(BigInt(end64At), 8);
				locator.writeUInt32LE(1, 16);
				await this.#write(Buffer.concat([end64, locator]));
			}
			const end = Buffer.alloc(22);
			end.writeUInt32LE(END, 0);
			end.writeUInt16LE(zip64 ? MAX_16 : count, 8);
			end.writeUInt16LE(zip64 ? MAX_16 : count, 10);
			end.writeUInt32LE(zip64 ? MAX_32 : size, 12);
			end.writeUInt32LE(zip64 ? MAX_32 : start, 16);
			await this.#write(end);
			await this.#file.sync();
			return { bytes: this.#position, sha256: this.#hash.digest('hex'), entries: count };
		} finally {
			await this.#file.close();
		}
	}

	/** Gives up: closes the file without finishing it (the caller removes it). */
	async abandon(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#file.close();
	}

	#central(entry: Entry): Buffer {
		const far = entry.offset >= this.#limits.offset;
		const extra = far ? Buffer.alloc(12) : Buffer.alloc(0);
		if (far) {
			extra.writeUInt16LE(0x0001, 0);
			extra.writeUInt16LE(8, 2);
			extra.writeBigUInt64LE(BigInt(entry.offset), 4);
		}
		const header = Buffer.alloc(46);
		header.writeUInt32LE(CENTRAL_HEADER, 0);
		header.writeUInt16LE(45, 4);
		header.writeUInt16LE(far ? 45 : 20, 6);
		header.writeUInt16LE(FLAGS, 8);
		header.writeUInt16LE(entry.method, 10);
		header.writeUInt16LE(entry.time, 12);
		header.writeUInt16LE(entry.date, 14);
		header.writeUInt32LE(entry.crc, 16);
		header.writeUInt32LE(entry.compressed, 20);
		header.writeUInt32LE(entry.size, 24);
		header.writeUInt16LE(entry.name.length, 28);
		header.writeUInt16LE(extra.length, 30);
		header.writeUInt32LE(far ? MAX_32 : entry.offset, 42);
		return Buffer.concat([header, entry.name, extra]);
	}
}
