import { mkdir, readdir, rename, rmdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, messages } from '../../database/schema.ts';
import { mailboxFolderName, messageFileName, resolveStoragePath } from './eml-store.ts';

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

export async function relayoutFiles(
	db: Queryable,
	backupRoot: string,
	options: {
		stopping: () => boolean;
		progress: (progress: RelayoutProgress) => void;
		problem: (message: string) => void;
	}
): Promise<RelayoutOutcome> {
	const rows = oldLayoutRows(db);
	const outcome: RelayoutOutcome = { total: rows.length, moved: 0, problems: 0, stopped: false };
	const roots = new Set<string>();
	for (const row of rows) {
		if (options.stopping()) {
			outcome.stopped = true;
			break;
		}
		const mailboxRoot = mailboxFolderName(row.address, row.kind);
		const target = `${mailboxRoot}/${messageFileName(row.receivedAt?.getTime() ?? null, row.subject, row.graphId)}`;
		const from = resolveStoragePath(backupRoot, row.filePath);
		const to = resolveStoragePath(backupRoot, target);
		roots.add(row.filePath.split('/')[0] ?? mailboxRoot);
		try {
			const sourceThere = await exists(from);
			const targetThere = await exists(to);
			if (sourceThere && targetThere) {
				throw new Error(`both ${row.filePath} and ${target} exist; both are kept`);
			}
			if (!sourceThere && !targetThere) {
				throw new Error(`${row.filePath} is missing from the backup folder`);
			}
			if (sourceThere) {
				await mkdir(dirname(to), { recursive: true });
				await rename(from, to);
			}
			db.update(messages).set({ filePath: target }).where(eq(messages.id, row.id)).run();
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
		await removeEmptyFolders(resolveStoragePath(backupRoot, root), true);
	}
	options.progress(outcome);
	return outcome;
}

/** Removes the folders under `folder` that hold no files; `keep` keeps `folder` itself. */
export async function removeEmptyFolders(folder: string, keep: boolean): Promise<boolean> {
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
