import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dosDateTime, ZipWriter } from './zip-writer.ts';
import { readZip } from '#tests/support/read-zip.ts';
import { rangeOf } from './download.ts';

const folders: string[] = [];
afterEach(async () => {
	for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function written(limits?: { offset: number; entries: number }) {
	const folder = await mkdtemp(join(tmpdir(), 'lookstow-zip-'));
	folders.push(folder);
	const path = join(folder, 'pack.zip');
	const zip = await ZipWriter.create(path, limits);
	const files = [
		{ name: 'Pack/README.txt', data: Buffer.from('hello '.repeat(500)) },
		{
			name: 'Pack/messages/ann@example.com/2024-03-05 0912 Timesheet — wk 12.eml',
			data: Buffer.from('Subject: x\r\n\r\nbody')
		},
		{ name: 'Pack/photo.bin', data: randomBytes(20_000) },
		{ name: 'Pack/empty.txt', data: Buffer.alloc(0) }
	];
	for (const file of files) await zip.add(file.name, file.data, new Date(2024, 2, 5, 9, 12, 30));
	const result = await zip.finish();
	return { files, result, bytes: await readFile(path) };
}

describe('the ZIP writer', () => {
	it('writes every file so it reads back exactly, compressed or stored as is', async () => {
		const { files, result, bytes } = await written();
		const read = readZip(bytes);
		expect(read.zip64).toBe(false);
		expect(read.files.map((file) => file.name)).toEqual(files.map((file) => file.name));
		for (const [index, file] of files.entries()) {
			expect(read.files[index]?.data.equals(file.data)).toBe(true);
		}
		expect(result).toEqual({
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			entries: 4
		});
		// Text shrinks; random bytes are stored, never made bigger.
		expect(bytes.length).toBeLessThan(20_000 + 3_000 + 2_000);
	});

	it('becomes ZIP64 past its limits and still reads back', async () => {
		const { files, bytes } = await written({ offset: 100, entries: 3 });
		const read = readZip(bytes);
		expect(read.zip64).toBe(true);
		for (const [index, file] of files.entries()) {
			expect(read.files[index]?.data.equals(file.data)).toBe(true);
		}
	});

	it('keeps the date in the DOS form, 1980 at the earliest', () => {
		expect(dosDateTime(new Date(2024, 2, 5, 9, 12, 30))).toEqual({
			date: ((2024 - 1980) << 9) | (3 << 5) | 5,
			time: (9 << 11) | (12 << 5) | 15
		});
		expect(dosDateTime(new Date(1975, 0, 1))).toEqual({ date: 33, time: 0 });
	});
});

describe('resuming a download', () => {
	it('reads one byte range, and says when one is outside the file', () => {
		expect(rangeOf(null, 100)).toBe('whole');
		expect(rangeOf('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
		expect(rangeOf('bytes=40-', 100)).toEqual({ start: 40, end: 99 });
		expect(rangeOf('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
		expect(rangeOf('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
		expect(rangeOf('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
		expect(rangeOf('bytes=100-', 100)).toBe('unsatisfiable');
		expect(rangeOf('bytes=20-10', 100)).toBe('unsatisfiable');
		expect(rangeOf('bytes=0-1,5-6', 100)).toBe('whole');
	});
});
