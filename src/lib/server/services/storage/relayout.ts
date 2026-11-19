import { mkdir, readdir, rename, rmdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, messages } from '../../database/schema.ts';
import {
	mailboxFolderName,
	messageFileName,
	resolveStoragePath,
	stampedName
} from './eml-store.ts';

/**
 * Moves message files stored before 0.4.0 (under mail-folder paths such as
 * `<address>/Inbox/2024/…`) into the date layout (`<address>/<yyyy>/<mm>/…`), records each new
 * path in the database, then removes the folders left empty. After it, which folder a message
 * is in lives only in the database.
 *
 * Safe to stop and run again at any point: each file is renamed, then its row updated. A file
 * already at its new path (stopped between the two) only gets its row updated. A rename never
 * replaces a file, and the file's bytes (and so its SHA-256) do not change.
 */
const DATE_LAYOUT = /^[^/]+\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}_\d{6}_[^/]+$/;

export type RelayoutProgress = { total: number; moved: number; problems: number };

export type RelayoutOutcome = RelayoutProgress & { stopped: boolean };

/** Messages still in the old layout: archive items were never stored that way. */
function oldLayoutRows(db: Queryable) {
	return db
		.select({
			id: messages.id,
			filePath: messages.filePath,
			receivedAt: messages.receivedAt,
			subject: messages.subject,
			graphId: messages.graphId,
			address: mailboxes.address,
			kind: mailboxes.kind
		})
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.all()
		.filter((row) => row.kind !== 'archive' && !DATE_LAYOUT.test(row.filePath));
}

export function countOldLayout(db: Queryable): number {
	return oldLayoutRows(db).length;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

type RelayoutOptions = {
	stopping: () => boolean;
	progress: (progress: RelayoutProgress) => void;
	problem: (message: string) => void;
};

export async function relayoutFiles(
	db: Queryable,
	backupRoot: string,
	options: RelayoutOptions
): Promise<RelayoutOutcome> {
	const moves = oldLayoutRows(db).map((row) => ({
		id: row.id,
		from: row.filePath,
		to: `${mailboxFolderName(row.address, row.kind)}/${messageFileName(row.receivedAt?.getTime() ?? null, row.subject, row.graphId)}`
	}));
	return moveStoredFiles(db, backupRoot, moves, options);
}

/** `yyyy-mm-dd_hhmmss_` at the start of a stored file's name, and the rest after it. */
const STAMPED_NAME = /^(.*\/)\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}_\d{6}_([^/]+)$/;

/**
 * Online archive items copied before 0.6.0 were filed by the date they moved into the archive
 * (all the export says); 0.6.0 reads each item's received date into the index. This moves each
 * file to the month it was received, keeping the rest of its name. Items whose received date is
 * not known keep their place, and so does every item already filed by it.
 */
export async function refileArchiveItems(
	db: Queryable,
	backupRoot: string,
	options: RelayoutOptions
): Promise<RelayoutOutcome> {
	const moves = archiveRows(db).flatMap((row) => {
		const parts = STAMPED_NAME.exec(row.filePath);
		if (parts === null || row.receivedAt === null) return [];
		const to = `${parts[1] ?? ''}${stampedName(row.receivedAt.getTime(), parts[2] ?? '')}`;
		return to === row.filePath ? [] : [{ id: row.id, from: row.filePath, to }];
	});
	return moveStoredFiles(db, backupRoot, moves, options);
}

function archiveRows(db: Queryable) {
	return db
		.select({ id: messages.id, filePath: messages.filePath, receivedAt: messages.receivedAt })
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.where(eq(mailboxes.kind, 'archive'))
		.all()
		.filter((row) => row.filePath.endsWith('.fts'));
}

type Move = { id: string; from: string; to: string };

/**
 * Moves stored files to new paths under the backup folder and records each new path: a rename
 * on the same drive, so the bytes (and SHA-256) are unchanged. A file already at its new path
 * only gets its row updated; a move that would replace a file is refused and both are kept.
 * The folders left empty are removed.
 */
async function moveStoredFiles(
	db: Queryable,
	backupRoot: string,
	moves: readonly Move[],
	options: RelayoutOptions
): Promise<RelayoutOutcome> {
	const outcome: RelayoutOutcome = { total: moves.length, moved: 0, problems: 0, stopped: false };
	const roots = new Set<string>();
	for (const move of moves) {
		if (options.stopping()) {
			outcome.stopped = true;
			break;
		}
		const from = resolveStoragePath(backupRoot, move.from);
		const to = resolveStoragePath(backupRoot, move.to);
		roots.add(move.from.split('/')[0] ?? '');
		try {
			const sourceThere = await exists(from);
			const targetThere = await exists(to);
			if (sourceThere && targetThere) {
				throw new Error(`both ${move.from} and ${move.to} exist; both are kept`);
			}
			if (!sourceThere && !targetThere) {
				throw new Error(`${move.from} is missing from the backup folder`);
			}
			if (sourceThere) {
				await mkdir(dirname(to), { recursive: true });
				await rename(from, to);
			}
			db.update(messages).set({ filePath: move.to }).where(eq(messages.id, move.id)).run();
			outcome.moved += 1;
		} catch (error) {
			outcome.problems += 1;
			// The first few are worth reading; a thousand of the same are not.
			if (outcome.problems <= 5) {
				options.problem(error instanceof Error ? error.message : String(error));
			}
		}
		if ((outcome.moved + outcome.problems) % 200 === 0) {
			options.progress(outcome);
		}
	}
	for (const root of roots) {
		if (root !== '') await removeEmptyFolders(resolveStoragePath(backupRoot, root), true);
	}
	options.progress(outcome);
	return outcome;
}

/** Removes the folders under `folder` that hold no files; `keep` keeps `folder` itself. */
async function removeEmptyFolders(folder: string, keep: boolean): Promise<boolean> {
	let entries;
	try {
		entries = await readdir(folder, { withFileTypes: true });
	} catch {
		return false;
	}
	let empty = true;
	for (const entry of entries) {
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			const removed = await removeEmptyFolders(resolveStoragePath(folder, entry.name), false);
			if (!removed) empty = false;
		} else {
			empty = false;
		}
	}
	if (empty && !keep) {
		try {
			await rmdir(folder);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}
