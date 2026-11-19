import type { Queryable } from '../../database/connection.ts';
import type { GraphClient } from '../graph/client.ts';
import { markMessageDeleted } from '../mailboxes/repository.ts';
import { folderStoragePath } from '../storage/eml-store.ts';

/** What a mailbox sync and an archive sync both work with. */
export type SyncContext = {
	db: Queryable;
	client: GraphClient;
	backupRoot: string;
	now: () => number;
	/** Set when the service is stopping: the sync ends after the current page. */
	stopping: () => boolean;
	/** Live progress for the console. */
	progress: (update: { folder: string; stored: number; bytes: number }) => void;
};

export type SyncOutcome = {
	added: number;
	removed: number;
	byteCount: number;
	firstCopyDone: boolean;
	stoppedEarly: boolean;
};

/** A message a folder's delta says left it, applied once every folder has been read. */
export type PendingRemoval = { folderId: string; graphId: string };

/**
 * Records deletions at the end of a sync, not as each folder reports them. A moved message
 * leaves its old folder (that folder's delta says removed) and arrives in the new one; reading
 * every folder first means a move is recorded as a move, and only a message still filed where it
 * left is recorded as deleted at the source.
 */
export function applyRemovals(
	context: SyncContext,
	mailboxId: string,
	pending: readonly PendingRemoval[]
): number {
	let removed = 0;
	for (const removal of pending) {
		if (
			markMessageDeleted(context.db, mailboxId, removal.folderId, removal.graphId, context.now())
		) {
			removed += 1;
		}
	}
	return removed;
}

/**
 * Storage paths for Graph's folders. Two folders whose names only differ in characters Windows
 * forbids would map to the same path, so the later one gets a numbered suffix.
 */
export function withUniqueStoragePaths(
	folders: readonly { graphId: string; path: string }[]
): { graphId: string; path: string; storagePath: string }[] {
	const used = new Set<string>();
	return folders.map((folder) => {
		const base = folderStoragePath(folder.path);
		let storagePath = base;
		for (let n = 2; used.has(storagePath.toLowerCase()); n++) {
			storagePath = `${base} ~${n}`;
		}
		used.add(storagePath.toLowerCase());
		return { ...folder, storagePath };
	});
}
