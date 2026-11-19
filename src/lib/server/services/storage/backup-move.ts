import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rmdir,
	stat,
	unlink,
	writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MARKER_FILE } from './backup-marker.ts';
import { measureDisk } from './disk.ts';
import { toStoredPath } from './eml-store.ts';

/**
 * Moving the backup to another folder (docs/specs/SPEC-BACKUP-FOLDER-MOVE.md, docs/decisions.md
 * "Moving the backup folder"). Files are copied, never moved: each copy goes to a temporary name,
 * is read back and checked against the index's SHA-256 (or the source's, for files the index
 * does not know), and only then takes its real name. The old copy is untouched until the admin
 * removes it, and removing it deletes only files whose copy is in place with the same contents.
 * Both passes walk the folder in a fixed order and skip work already done, so either can stop at
 * any point and start again.
 */

const COPYING = '.lookstow-copy';
const WRITE_TEST = '.lookstow-write-test';

export type MoveProgress = { files: number; bytes: number; problems: string[] };

/** Problems kept for the activity log; the count goes on beyond it. */
const PROBLEMS_KEPT = 50;

function inside(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Every file under `root`, relative to it, in a fixed order; temporary copies are left out. */
async function* filesUnder(root: string, below = ''): AsyncGenerator<string> {
	const entries = await readdir(join(root, below), { withFileTypes: true });
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const path = below === '' ? entry.name : join(below, entry.name);
		if (entry.isDirectory()) {
			yield* filesUnder(root, path);
		} else if (entry.isFile() && !entry.name.endsWith(COPYING) && entry.name !== WRITE_TEST) {
			yield path;
		}
	}
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash('sha256');
	await pipeline(createReadStream(path), hash);
	return hash.digest('hex');
}

/** Copies a file, returning the SHA-256 of what was read; the copy is on disk when it returns. */
async function copyHashing(source: string, target: string): Promise<string> {
	const hash = createHash('sha256');
	await pipeline(
		createReadStream(source),
		new Transform({
			transform(chunk: Buffer, _encoding, done) {
				hash.update(chunk);
				done(null, chunk);
			}
		}),
		createWriteStream(target, { flags: 'w' })
	);
	const handle = await open(target, 'r+');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	return hash.digest('hex');
}

async function isEmptyOrOurs(folder: string, markerId: string): Promise<boolean> {
	const entries = await readdir(folder);
	if (entries.length === 0) return true;
	if (!entries.includes(MARKER_FILE)) return false;
	try {
		return (await readFile(join(folder, MARKER_FILE), 'utf8')).includes(markerId);
	} catch {
		return false;
	}
}

/**
 * Why the backup cannot move from `from` to `to`, or null when it can. `to` must be a prepared
 * folder (\`lookstow backup-folder prepare\`): there, empty or holding an earlier try at this same
 * move, writable by the service, and on a drive with room for `bytesNeeded`.
 */
export async function moveTargetProblem(
	from: string,
	to: string,
	markerId: string,
	bytesNeeded: number
): Promise<string | null> {
	if (!isAbsolute(to)) return 'Enter the new folder as a full path.';
	if (resolve(to) === resolve(from)) return 'That is the backup folder already.';
	if (inside(from, to)) return 'The new folder cannot be inside the backup folder.';
	if (inside(to, from)) return 'The backup folder cannot be inside the new folder.';
	let folder: Awaited<ReturnType<typeof stat>>;
	try {
		folder = await stat(to);
	} catch {
		return `${to} is not there. Prepare it first: on the server, as an administrator, run \`lookstow backup-folder prepare "${to}"\`.`;
	}
	if (!folder.isDirectory()) return `${to} is a file, not a folder.`;
	if (!(await isEmptyOrOurs(to, markerId))) {
		return `${to} is not empty. Choose an empty folder, prepared with \`lookstow backup-folder prepare\`.`;
	}
	try {
		await writeFile(join(to, WRITE_TEST), 'lookstow');
		await unlink(join(to, WRITE_TEST));
	} catch {
		return `Lookstow cannot write to ${to}. Prepare it first: on the server, as an administrator, run \`lookstow backup-folder prepare "${to}"\`.`;
	}
	const disk = measureDisk(to);
	if (disk !== null && disk.freeBytes < bytesNeeded) {
		return `${to} has ${String(Math.floor(disk.freeBytes / 1e9))} GB free; the backup needs about ${String(Math.ceil(bytesNeeded / 1e9))} GB.`;
	}
	return null;
}

/**
 * Copies every file under `from` to the same place under `to`, checked. `indexed` gives the
 * SHA-256 the index holds for a stored path (forward slashes), or undefined for files the index
 * does not know (the index copies, the marker). A copy already in place with the right contents
 * is kept. A source file that differs from the index is still copied, and named as a problem. A
 * copy that differs from what was read stops the move: the new drive is not to be trusted.
 */
export async function copyBackup(options: {
	from: string;
	to: string;
	indexed: (storedPath: string) => string | undefined;
	stopping: () => boolean;
	progress: (progress: MoveProgress) => void;
}): Promise<MoveProgress & { stopped: boolean }> {
	const { from, to, indexed, stopping, progress } = options;
	const done: MoveProgress = { files: 0, bytes: 0, problems: [] };
	let problemCount = 0;
	const problem = (text: string) => {
		problemCount += 1;
		if (done.problems.length < PROBLEMS_KEPT) done.problems.push(text);
	};
	for await (const path of filesUnder(from)) {
		if (stopping()) return { ...done, stopped: true };
		const source = join(from, path);
		const target = join(to, path);
		const expected = indexed(toStoredPath(path));
		const size = (await stat(source)).size;
		if (existsSync(target)) {
			const wanted = expected ?? (await hashFile(source));
			if ((await hashFile(target)) === wanted) {
				done.files += 1;
				done.bytes += size;
				progress(done);
				continue;
			}
		}
		await mkdir(dirname(target), { recursive: true });
		const copying = `${target}${COPYING}`;
		const read = await copyHashing(source, copying);
		if (expected !== undefined && read !== expected) {
			problem(`${path.split(sep).join('/')}: differs from the index; copied as it is`);
		}
		if ((await hashFile(copying)) !== read) {
			await unlink(copying);
			throw new Error(
				`The copy of ${path} on ${to} does not match what was read. The new drive may be failing; the move is stopped and the backup stays where it was.`
			);
		}
		await rename(copying, target);
		done.files += 1;
		done.bytes += size;
		progress(done);
	}
	if (problemCount > done.problems.length) {
		done.problems.push(`and ${String(problemCount - done.problems.length)} more`);
	}
	return { ...done, stopped: false };
}

/** Stored paths (forward slashes) the index holds whose file is not under `root`. */
export function missingUnder(root: string, storedPaths: Iterable<string>): string[] {
	const missing: string[] = [];
	for (const path of storedPaths) {
		if (!existsSync(join(root, ...path.split('/')))) missing.push(path);
	}
	return missing;
}

/**
 * Removes the old copy after a move: each file under `from` is deleted only when the same file
 * under `to` has the same SHA-256; any other is kept and named. Empty folders go last.
 */
export async function removeOldCopy(options: {
	from: string;
	to: string;
	stopping: () => boolean;
	progress: (removed: number) => void;
}): Promise<{ removed: number; kept: string[]; stopped: boolean }> {
	const { from, to, stopping, progress } = options;
	if (inside(from, to) || inside(to, from)) {
		throw new Error('The old and new backup folders overlap; nothing was removed.');
	}
	let removed = 0;
	const kept: string[] = [];
	for await (const path of filesUnder(from)) {
		if (stopping()) return { removed, kept, stopped: true };
		const old = join(from, path);
		const copy = join(to, path);
		if (existsSync(copy) && (await hashFile(copy)) === (await hashFile(old))) {
			await unlink(old);
			removed += 1;
			progress(removed);
		} else {
			kept.push(path.split(sep).join('/'));
		}
	}
	await removeEmptyFolders(from);
	return { removed, kept, stopped: false };
}

/** Deletes folders under (and including) `root` that hold nothing, deepest first. */
async function removeEmptyFolders(root: string): Promise<void> {
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) await removeEmptyFolders(join(root, entry.name));
	}
	if ((await readdir(root)).length === 0) {
		await rmdir(root);
	}
}
