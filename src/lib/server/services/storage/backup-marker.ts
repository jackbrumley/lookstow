import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The backup folder's marker (docs/specs/SPEC-BACKUP-FOLDER-MOVE.md): a small file at its top,
 * `.lookstow-backup`, holding an id the index also keeps. Before any sync writes, the engine
 * checks the folder still carries it. A drive that is not attached, a mount that did not come
 * up, or another folder in the backup folder's place then stops the backup with a reason,
 * instead of a fresh backup being written in the wrong place.
 */
export const MARKER_FILE = '.lookstow-backup';

const markerSchema = z.object({ lookstow: z.literal('backup-folder'), id: z.uuid() });

export type BackupFolderCheck =
	| { kind: 'ok' }
	/** Write the marker: a new backup folder, or one from before markers that holds its mail. */
	| { kind: 'mark'; id: string }
	| { kind: 'refused'; reason: string };

function readMarker(root: string): { id: string } | 'none' | 'unreadable' {
	const path = join(root, MARKER_FILE);
	if (!existsSync(path)) return 'none';
	try {
		const parsed = markerSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
		return parsed.success ? { id: parsed.data.id } : 'unreadable';
	} catch {
		return 'unreadable';
	}
}

function isFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Whether the backup folder at `root` is the one the index knows. `known` is the id the index
 * keeps (null before the first marker), `sample` gives a stored file's path relative to the root
 * (null when nothing is stored yet; asked only when there is no marker), which shows that a folder without a marker really holds this
 * backup. `newId` names a new folder.
 */
export function checkBackupFolder(
	root: string,
	known: { id: string } | null,
	sample: () => string | null,
	newId: () => string = randomUUID
): BackupFolderCheck {
	const marker = readMarker(root);
	if (marker === 'unreadable') {
		return {
			kind: 'refused',
			reason: `The backup folder's marker (${join(root, MARKER_FILE)}) cannot be read. Backups are stopped so nothing is written to the wrong place.`
		};
	}
	if (marker !== 'none') {
		if (known === null || marker.id === known.id) return { kind: 'ok' };
		return {
			kind: 'refused',
			reason: `${root} holds a different Lookstow backup (its marker does not match this index). Backups are stopped. Check the backup folder in Settings.`
		};
	}
	const stored = sample();
	if (stored === null) {
		// Nothing stored yet: a new backup folder (made now if it is not there).
		return { kind: 'mark', id: known?.id ?? newId() };
	}
	if (!isFolder(root)) {
		return {
			kind: 'refused',
			reason: `The backup folder ${root} is not there. If it is on a drive that is not attached, attach it. Backups are stopped until it is back.`
		};
	}
	if (!existsSync(join(root, ...stored.split('/')))) {
		return {
			kind: 'refused',
			reason: `${root} has no backup marker and does not hold the stored mail. If the backup drive is not attached, attach it. Backups are stopped until the backup folder is back.`
		};
	}
	// A backup folder from before markers, with its mail in place: mark it.
	return { kind: 'mark', id: known?.id ?? newId() };
}

/** Writes the marker file (only when checkBackupFolder said to). */
export function writeMarker(root: string, id: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, MARKER_FILE),
		`${JSON.stringify({ lookstow: 'backup-folder', id }, null, '\t')}\n`,
		{ flag: 'wx' }
	);
}
