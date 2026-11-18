import { closeSync, openSync, readSync } from 'node:fs';

/** Reads a small control file from the data folder, refusing one larger than `limit` bytes. */
export function readBounded(path: string, limit: number): Buffer {
	const fd = openSync(path, 'r');
	try {
		const bytes = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < bytes.length) {
			const read = readSync(fd, bytes, size, bytes.length - size, null);
			if (read === 0) break;
			size += read;
		}
		if (size > limit) throw new Error(`Update control file exceeds ${String(limit)} bytes.`);
		return bytes.subarray(0, size);
	} finally {
		closeSync(fd);
	}
}

export function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
