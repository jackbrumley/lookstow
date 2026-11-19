import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeMarker } from './backup-marker.ts';
import { copyBackup, missingUnder, moveTargetProblem, removeOldCopy } from './backup-move.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const folders: string[] = [];

function folder(): string {
	const path = mkdtempSync(join(tmpdir(), 'lookstow-move-'));
	folders.push(path);
	return path;
}

afterEach(() => {
	for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** A backup folder with a marker, two messages the index knows and an index snapshot. */
function backup(): { root: string; index: Map<string, string> } {
	const root = folder();
	writeMarker(root, ID);
	const files: Record<string, string> = {
		'ann@example.com/2026/11/m1.eml': 'first message',
		'ann@example.com/2026/11/m2.eml': 'second message',
		'.lookstow-index/lookstow-2026-11-19.db': 'index copy'
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return {
		root,
		index: new Map([
			['ann@example.com/2026/11/m1.eml', sha('first message')],
			['ann@example.com/2026/11/m2.eml', sha('second message')]
		])
	};
}

function copy(from: string, to: string, index: Map<string, string>, stopAfter = Infinity) {
	let copied = 0;
	return copyBackup({
		from,
		to,
		indexed: (path) => index.get(path),
		stopping: () => copied >= stopAfter,
		progress: (progress) => {
			copied = progress.files;
		}
	});
}

describe('choosing the folder to move to', () => {
	it('refuses a folder that is missing, inside the backup, not empty or too small', async () => {
		const { root } = backup();
		expect(await moveTargetProblem(root, join(folder(), 'missing'), ID, 0)).toContain(
			'backup-folder prepare'
		);
		expect(await moveTargetProblem(root, join(root, 'inner'), ID, 0)).toContain('inside');
		expect(await moveTargetProblem(root, root, ID, 0)).toContain('already');
		const busy = folder();
		writeFileSync(join(busy, 'other.txt'), 'x');
		expect(await moveTargetProblem(root, busy, ID, 0)).toContain('not empty');
		expect(await moveTargetProblem(root, folder(), ID, Number.MAX_SAFE_INTEGER)).toContain(
			'GB free'
		);
	});

	it('takes an empty folder, or one holding an earlier try at this move', async () => {
		const { root } = backup();
		expect(await moveTargetProblem(root, folder(), ID, 0)).toBeNull();
		const earlier = folder();
		writeMarker(earlier, ID);
		writeFileSync(join(earlier, 'partial.eml'), 'x');
		expect(await moveTargetProblem(root, earlier, ID, 0)).toBeNull();
	});
});

describe('copying the backup', () => {
	it('copies every file, the marker and the index snapshots, checked', async () => {
		const { root, index } = backup();
		const to = folder();
		const result = await copy(root, to, index);
		expect(result).toMatchObject({ files: 4, problems: [], stopped: false });
		expect(readFileSync(join(to, 'ann@example.com/2026/11/m2.eml'), 'utf8')).toBe('second message');
		expect(existsSync(join(to, '.lookstow-backup'))).toBe(true);
		expect(existsSync(join(to, '.lookstow-index/lookstow-2026-11-19.db'))).toBe(true);
		expect(missingUnder(to, index.keys())).toEqual([]);
		// The old copy is untouched.
		expect(readFileSync(join(root, 'ann@example.com/2026/11/m1.eml'), 'utf8')).toBe(
			'first message'
		);
	});

	it('stopped half way and started again, it loses and duplicates nothing', async () => {
		const { root, index } = backup();
		const to = folder();
		expect((await copy(root, to, index, 2)).stopped).toBe(true);
		const again = await copy(root, to, index);
		expect(again).toMatchObject({ files: 4, stopped: false });
		expect(missingUnder(to, index.keys())).toEqual([]);
		const leftovers = readdirSync(to, { recursive: true }).filter((name) =>
			String(name).endsWith('.lookstow-copy')
		);
		expect(leftovers).toEqual([]);
	});

	it('a file that differs from the index is copied as it is, and named', async () => {
		const { root, index } = backup();
		index.set('ann@example.com/2026/11/m1.eml', sha('what the index expected'));
		const result = await copy(root, folder(), index);
		expect(result.problems).toEqual([
			'ann@example.com/2026/11/m1.eml: differs from the index; copied as it is'
		]);
	});

	it('names index files missing from the new folder', () => {
		expect(missingUnder(folder(), ['ann@example.com/2026/11/m9.eml'])).toEqual([
			'ann@example.com/2026/11/m9.eml'
		]);
	});
});

describe('removing the old copy', () => {
	it('deletes only files whose copy is identical, keeps the rest, then empty folders', async () => {
		const { root, index } = backup();
		const to = folder();
		await copy(root, to, index);
		writeFileSync(join(to, 'ann@example.com/2026/11/m2.eml'), 'changed on the new drive');
		mkdirSync(join(root, 'bob@example.com'), { recursive: true });
		writeFileSync(join(root, 'bob@example.com/only-here.eml'), 'never copied');
		const result = await removeOldCopy({
			from: root,
			to,
			stopping: () => false,
			progress: () => undefined
		});
		expect(result.removed).toBe(3);
		expect(result.kept.sort()).toEqual([
			'ann@example.com/2026/11/m2.eml',
			'bob@example.com/only-here.eml'
		]);
		expect(existsSync(join(root, 'ann@example.com/2026/11/m2.eml'))).toBe(true);
		expect(existsSync(join(root, '.lookstow-index'))).toBe(false);
		expect(readFileSync(join(to, 'ann@example.com/2026/11/m1.eml'), 'utf8')).toBe('first message');
	});

	it('removes everything when every copy is in place, and refuses overlapping folders', async () => {
		const { root, index } = backup();
		const to = folder();
		await copy(root, to, index);
		const result = await removeOldCopy({
			from: root,
			to,
			stopping: () => false,
			progress: () => undefined
		});
		expect(result).toMatchObject({ removed: 4, kept: [] });
		expect(existsSync(root)).toBe(false);
		await expect(
			removeOldCopy({
				from: to,
				to: join(to, 'x'),
				stopping: () => false,
				progress: () => undefined
			})
		).rejects.toThrow('overlap');
	});
});
