import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

/**
 * How backups sit on disk: plain .eml files anyone can open, filed by mailbox and date.
 *
 *   <backup root>/<address>/<yyyy>/<mm>/<yyyy-mm-dd>_<hhmmss>_<subject>_<id>.eml
 *   <backup root>/<address> (archive)/<yyyy>/<mm>/<...>_<message class>_<id>.fts
 *
 * A file is written once and never moved or renamed, so its SHA-256 stays valid for ever and a
 * move in the mailbox costs nothing. Which folder a message is in, and every move, is in the
 * database (message_events); folder views are built from it, not from the disk. Files stored
 * before 0.4.0 sat under folder paths; relayout.ts moves them into this layout once, at startup.
 *
 * Every name is made safe for Windows and Linux alike, and kept short enough that a deep
 * folder tree stays inside Windows' path limits.
 */
const MAX_SEGMENT = 60;
const MAX_SUBJECT = 40;
const FORBIDDEN = '<>:"/\\|?*';
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** One path segment: no characters Windows forbids, no trailing dot or space, not reserved. */
export function safeSegment(name: string, maxLength = MAX_SEGMENT): string {
	let safe = Array.from(name, (character) =>
		// Control characters and the ones Windows forbids in names.
		character.charCodeAt(0) < 32 || FORBIDDEN.includes(character) ? '_' : character
	)
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, maxLength)
		.replace(/[. ]+$/, '');
	if (safe === '' || safe === '.' || safe === '..') {
		safe = '_';
	}
	return RESERVED.test(safe) ? `_${safe}` : safe;
}

/** The mailbox's folder under the backup root. */
export function mailboxFolderName(address: string, kind: string): string {
	return safeSegment(kind === 'archive' ? `${address} (archive)` : address, 120);
}

/** A mail folder's display path (`Inbox/Projects`) as a relative storage path. */
export function folderStoragePath(displayPath: string): string {
	return displayPath
		.split('/')
		.map((segment) => safeSegment(segment))
		.join('/');
}

/**
 * The message's file name, relative to its folder: dated, readable, and unique through a short
 * hash of Graph's immutable id (two messages can share a subject and second).
 */
export function messageFileName(
	receivedAt: number | null,
	subject: string,
	graphId: string
): string {
	const when = new Date(receivedAt ?? 0);
	const tag = createHash('sha256').update(graphId).digest('hex').slice(0, 10);
	const title = safeSegment(subject === '' ? 'no subject' : subject, MAX_SUBJECT);
	return `${datePath(when)}_${title}_${tag}.eml`;
}

/**
 * An online-archive item's file name: Exchange's full-fidelity export (`.fts`), which the export
 * API gives without a subject, so the name is the item's date, its message class and a short
 * hash of its id.
 */
export function archiveItemFileName(
	createdAt: number | null,
	type: string,
	graphId: string
): string {
	const tag = createHash('sha256').update(graphId).digest('hex').slice(0, 10);
	return `${datePath(new Date(createdAt ?? 0))}_${safeSegment(type, 30)}_${tag}.fts`;
}

/** A stored file's dated path for another date, keeping the rest of its name after the stamp. */
export function stampedName(when: number, rest: string): string {
	return `${datePath(new Date(when))}_${rest}`;
}

/** `yyyy/mm/yyyy-mm-dd_hhmmss`: where and under what date a message file is written (UTC). */
function datePath(when: Date): string {
	const iso = when.toISOString();
	const stamp = iso.slice(0, 19).replace('T', '_').replaceAll(':', '');
	return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${stamp}`;
}

/** Joins forward-slash relative parts onto a root, for this platform. */
export function resolveStoragePath(root: string, ...relative: string[]): string {
	const parts = relative.flatMap((part) => part.split('/')).filter((part) => part !== '');
	if (parts.some((part) => part === '..' || part === '.')) {
		throw new Error(`Refusing a storage path that leaves the backup folder: ${relative.join('/')}`);
	}
	return join(root, ...parts);
}

export type StoredFile = { byteCount: number; sha256: string };

/**
 * Writes the message so a crash never leaves half a file under the real name: a temporary
 * file beside it, then a rename. An existing file with the same name is replaced (same id,
 * so the same message).
 */
export async function writeMessageFile(path: string, bytes: Buffer): Promise<StoredFile> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomBytes(4).toString('hex')}.partial`;
	try {
		await writeFile(temporary, bytes);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
	return { byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Forward slashes for what is stored in the database, whatever the platform. */
export function toStoredPath(path: string): string {
	return path.split(sep).join('/');
}
