import type { Queryable } from '../../database/connection.ts';
import type { GraphClient } from '../graph/client.ts';
import { removeFromFolder, settleLeftMessages } from '../mailboxes/archive-links.ts';
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
		// In a mailbox with an online archive a message that leaves is archived or, after a
		// week with no archive copy, deleted (docs/specs/SPEC-ARCHIVE-LINKS.md).
		const outcome = removeFromFolder(
			context.db,
			mailboxId,
			removal.folderId,
			removal.graphId,
			context.now()
		);
		if (outcome === 'deleted') removed += 1;
	}
	return removed + settleLeftMessages(context.db, mailboxId, context.now());
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

/**
 * Microsoft's count for each folder that synced to its delta link, from the folder list read
 * after the sync, with how many messages a full listing returned where the sync listed the
 * folder from the start. A folder Microsoft did not count, or no longer lists, has none.
 */
export function countsFor(
	synced: readonly { id: string; graphId: string }[],
	after: readonly { graphId: string; totalItemCount: number | null }[],
	fullListings: ReadonlyMap<string, number>
): { folderId: string; count: number; listed: number | null }[] {
	const byGraphId = new Map(after.map((folder) => [folder.graphId, folder.totalItemCount]));
	return synced.flatMap((folder) => {
		const count = byGraphId.get(folder.graphId) ?? null;
		return count === null
			? []
			: [{ folderId: folder.id, count, listed: fullListings.get(folder.id) ?? null }];
	});
}
