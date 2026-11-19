import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStoredFile } from './stored-file.ts';

let folder: string;

beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), 'lookstow-stored-file-'));
});

afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});

describe('openStoredFile', () => {
	it('streams the whole file and gives its size', async () => {
		const path = join(folder, 'message.eml');
		const bytes = Buffer.alloc(200 * 1024, 'a');
		await writeFile(path, bytes);
		const opened = await openStoredFile(path);
		expect(opened?.byteCount).toBe(bytes.length);
		const received = Buffer.from(await new Response(opened?.body).arrayBuffer());
		expect(received.equals(bytes)).toBe(true);
	});

	it('returns null when the file is not on disk', async () => {
		expect(await openStoredFile(join(folder, 'missing.eml'))).toBeNull();
	});
});
