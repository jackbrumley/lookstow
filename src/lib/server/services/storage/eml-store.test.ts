import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	folderStoragePath,
	mailboxFolderName,
	archiveItemFileName,
	messageFileName,
	resolveStoragePath,
	safeSegment,
	writeMessageFile
} from './eml-store.ts';

describe('backup file names', () => {
	it('makes names Windows and Linux both accept', () => {
		expect(safeSegment('Re: Q3 <draft> "final"?')).toBe('Re_ Q3 _draft_ _final__');
		expect(safeSegment('ends with dots...')).toBe('ends with dots');
		expect(safeSegment('CON')).toBe('_CON');
		expect(safeSegment('nul.txt')).toBe('_nul.txt');
		expect(safeSegment('   ')).toBe('_');
		expect(safeSegment('tab\there')).toBe('tab_here');
		expect(safeSegment('x'.repeat(100))).toHaveLength(60);
	});

	it('keeps folder paths as folders', () => {
		expect(folderStoragePath('Inbox/Projects: 2026')).toBe('Inbox/Projects_ 2026');
		expect(mailboxFolderName('ann@example.com', 'archive')).toBe('ann@example.com (archive)');
	});

	it('names a message by date, subject and a short id hash', () => {
		const name = messageFileName(Date.UTC(2026, 0, 2, 3, 4, 5), 'Hello / world', 'AAMk-id');
		expect(name).toMatch(/^2026\/01\/2026-01-02_030405_Hello _ world_[0-9a-f]{10}\.eml$/);
		expect(messageFileName(0, '', 'id')).toMatch(/^1970\/01\/1970-01-01_000000_no subject_/);
		expect(archiveItemFileName(Date.UTC(2019, 6, 1), 'IPM.Note', 'x')).toMatch(
			/^2019\/07\/2019-07-01_000000_IPM.Note_[0-9a-f]{10}\.fts$/
		);
	});

	it('refuses a path that would leave the backup folder', () => {
		expect(() => resolveStoragePath('/backups', 'a/../../etc')).toThrow(/leaves the backup folder/);
		expect(resolveStoragePath('/backups', 'a/b', 'c.eml')).toBe(
			join('/backups', 'a', 'b', 'c.eml')
		);
	});

	it('writes the message whole, with its size and hash', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'lookstow-eml-'));
		const path = join(dir, 'm', 'a.eml');
		const stored = await writeMessageFile(path, Buffer.from('Subject: hi\r\n\r\nbody'));
		expect(stored.byteCount).toBe(19);
		expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await readFile(path, 'utf8')).toBe('Subject: hi\r\n\r\nbody');
		expect(await readdir(join(dir, 'm'))).toEqual(['a.eml']);
	});
});
