import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MARKER_FILE, checkBackupFolder, writeMarker } from './backup-marker.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const folders: string[] = [];

function folder(): string {
	const path = mkdtempSync(join(tmpdir(), 'lookstow-marker-'));
	folders.push(path);
	return path;
}

/** The reason a check refused, or what it said instead. */
function reason(check: ReturnType<typeof checkBackupFolder>): string {
	return check.kind === 'refused' ? check.reason : check.kind;
}

afterEach(() => {
	for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('the backup folder marker', () => {
	it('a new backup folder is marked, with a new id or the one the index keeps', () => {
		const root = join(folder(), 'not-made-yet');
		expect(
			checkBackupFolder(
				root,
				null,
				() => null,
				() => ID
			)
		).toEqual({ kind: 'mark', id: ID });
		expect(checkBackupFolder(root, { id: OTHER }, () => null)).toEqual({ kind: 'mark', id: OTHER });
		writeMarker(root, ID);
		expect(checkBackupFolder(root, { id: ID }, () => 'x')).toEqual({ kind: 'ok' });
	});

	it('a folder from before markers is marked only when it holds the stored mail', () => {
		const root = folder();
		mkdirSync(join(root, 'ann@example.com', '2026', '11'), { recursive: true });
		writeFileSync(join(root, 'ann@example.com', '2026', '11', 'm1.eml'), 'mail');
		expect(
			checkBackupFolder(
				root,
				null,
				() => 'ann@example.com/2026/11/m1.eml',
				() => ID
			)
		).toEqual({ kind: 'mark', id: ID });
		expect(checkBackupFolder(root, null, () => 'ann@example.com/2026/11/m2.eml').kind).toBe(
			'refused'
		);
	});

	it('a backup folder that is not there stops the backup instead of starting a new one', () => {
		const root = join(folder(), 'drive-not-attached');
		const check = checkBackupFolder(root, { id: ID }, () => 'ann@example.com/2026/11/m1.eml');
		expect(reason(check)).toContain('is not there');
	});

	it("another backup's folder, or a marker that cannot be read, stops the backup", () => {
		const root = folder();
		writeMarker(root, OTHER);
		expect(reason(checkBackupFolder(root, { id: ID }, () => null))).toContain(
			'a different Lookstow backup'
		);
		writeFileSync(join(root, MARKER_FILE), 'not json');
		expect(reason(checkBackupFolder(root, { id: ID }, () => null))).toContain('cannot be read');
	});

	it('never overwrites a marker', () => {
		const root = folder();
		writeMarker(root, ID);
		expect(() => {
			writeMarker(root, OTHER);
		}).toThrow();
		expect(checkBackupFolder(root, { id: ID }, () => null)).toEqual({ kind: 'ok' });
	});
});
