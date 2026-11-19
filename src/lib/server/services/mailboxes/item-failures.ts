import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, lte } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { itemFailures, mailFolders } from '../../database/schema.ts';

/**
 * All SQL for items that could not be copied (docs/specs/SPEC-THROUGHPUT.md 4.9.4). A failed item
 * is tried again after 15 minutes, then 1 hour, 4 hours and a day; after TERMINAL_ATTEMPTS it
 * waits for someone in the console.
 */
export const TERMINAL_ATTEMPTS = 5;
const RETRY_AFTER_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000] as const;

export type ItemFailure = typeof itemFailures.$inferSelect;

/** Records a failed try (the first or a later one) and when to try again. */
export function recordItemFailure(
	db: Queryable,
	item: {
		mailboxId: string;
		folderId: string;
		graphId: string;
		subject: string;
		receivedAt: number | null;
		error: string;
	},
	now: number
): void {
	const existing = db
		.select()
		.from(itemFailures)
		.where(and(eq(itemFailures.mailboxId, item.mailboxId), eq(itemFailures.graphId, item.graphId)))
		.get();
	const attempts = (existing?.attempts ?? 0) + 1;
	const wait = RETRY_AFTER_MS[Math.min(attempts - 1, RETRY_AFTER_MS.length - 1)] ?? 0;
	const values = {
		folderId: item.folderId,
		subject: item.subject,
		receivedAt: item.receivedAt === null ? null : new Date(item.receivedAt),
		attempts,
		nextTryAt: new Date(now + wait),
		lastError: item.error.slice(0, 1000),
		terminal: attempts >= TERMINAL_ATTEMPTS
	};
	if (existing === undefined) {
		db.insert(itemFailures)
			.values({
				id: randomUUID(),
				mailboxId: item.mailboxId,
				graphId: item.graphId,
				firstFailedAt: new Date(now),
				...values
			})
			.run();
	} else {
		db.update(itemFailures).set(values).where(eq(itemFailures.id, existing.id)).run();
	}
}

/** A folder's failed items due for another try, oldest first. */
export function dueItemFailures(db: Queryable, folderId: string, now: number): ItemFailure[] {
	return db
		.select()
		.from(itemFailures)
		.where(
			and(
				eq(itemFailures.folderId, folderId),
				eq(itemFailures.terminal, false),
				lte(itemFailures.nextTryAt, new Date(now))
			)
		)
		.orderBy(asc(itemFailures.firstFailedAt))
		.all();
}

/** The item was copied, or is gone from Microsoft 365: nothing more to try. */
export function clearItemFailure(db: Queryable, mailboxId: string, graphId: string): void {
	db.delete(itemFailures)
		.where(and(eq(itemFailures.mailboxId, mailboxId), eq(itemFailures.graphId, graphId)))
		.run();
}

/** A mailbox's items that could not be copied, with their folder, for the mailbox page. */
export function mailboxItemFailures(db: Queryable, mailboxId: string, limit = 50) {
	return db
		.select({
			graphId: itemFailures.graphId,
			folderPath: mailFolders.path,
			subject: itemFailures.subject,
			receivedAt: itemFailures.receivedAt,
			attempts: itemFailures.attempts,
			firstFailedAt: itemFailures.firstFailedAt,
			nextTryAt: itemFailures.nextTryAt,
			lastError: itemFailures.lastError,
			terminal: itemFailures.terminal
		})
		.from(itemFailures)
		.innerJoin(mailFolders, eq(itemFailures.folderId, mailFolders.id))
		.where(eq(itemFailures.mailboxId, mailboxId))
		.orderBy(asc(itemFailures.firstFailedAt))
		.limit(limit)
		.all();
}

export function countItemFailures(db: Queryable, mailboxId: string): number {
	return (
		db
			.select({ total: count() })
			.from(itemFailures)
			.where(eq(itemFailures.mailboxId, mailboxId))
			.get()?.total ?? 0
	);
}

/** Tries a terminal item again at the next sync (from the mailbox page). */
export function retryItemFailures(db: Queryable, mailboxId: string, now: number): number {
	return db
		.update(itemFailures)
		.set({ terminal: false, attempts: 0, nextTryAt: new Date(now) })
		.where(eq(itemFailures.mailboxId, mailboxId))
		.run().changes;
}
