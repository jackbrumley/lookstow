import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, mailFolders, messageEvents, messages } from '../../database/schema.ts';

/**
 * One email in two places: a person's mailbox and their online archive
 * (docs/specs/SPEC-ARCHIVE-LINKS.md). An archive policy moves old mail from the mailbox to the
 * archive; Microsoft gives the archive copy a new id, so without these links the move looked
 * like a deletion and a second, unrelated copy.
 *
 * - When a message leaves a mailbox that has an online archive it is marked `leftAt`, not
 *   deleted. If its archive copy is found it was archived; if not within SETTLE_MS, deleted.
 * - Copies are matched by person, Internet Message-ID and received time (section 3); a message
 *   without a Message-ID is never matched. Both files are kept.
 */
export const SETTLE_MS = 7 * 24 * 60 * 60_000;
const RECEIVED_SLACK_MS = 5_000;
const ARCHIVE_PREFIX = 'Online archive';

type MessageRow = typeof messages.$inferSelect;

function folderPath(db: Queryable, folderId: string): string | null {
	return (
		db
			.select({ path: mailFolders.path })
			.from(mailFolders)
			.where(eq(mailFolders.id, folderId))
			.get()?.path ?? null
	);
}

function recordEvent(db: Queryable, event: Omit<typeof messageEvents.$inferInsert, 'id'>): void {
	db.insert(messageEvents)
		.values({ id: randomUUID(), ...event })
		.run();
}

/** The person's online archive, if their mailbox (not itself an archive) has one. */
function archiveOf(db: Queryable, mailboxId: string): string | null {
	const mailbox = db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
	if (mailbox === undefined || mailbox.kind === 'archive') return null;
	return (
		db
			.select({ id: mailboxes.id })
			.from(mailboxes)
			.where(
				and(
					eq(mailboxes.userId, mailbox.userId),
					eq(mailboxes.kind, 'archive'),
					isNull(mailboxes.goneAt)
				)
			)
			.get()?.id ?? null
	);
}

/** "Archived" when both have happened: the copy is in the archive and it left the mailbox. */
function recordArchived(
	db: Queryable,
	message: MessageRow,
	archiveCopy: MessageRow,
	at: Date
): void {
	const from = folderPath(db, message.folderId);
	const to = folderPath(db, archiveCopy.folderId);
	recordEvent(db, {
		messageId: message.id,
		mailboxId: message.mailboxId,
		at,
		kind: 'archived',
		fromFolderPath: from,
		toFolderPath: `${ARCHIVE_PREFIX}/${to ?? ''}`
	});
}

export type Removal = 'deleted' | 'left' | 'archived' | 'none';

/**
 * A folder's delta says the message left it. In a mailbox with an online archive it is marked
 * left (or archived, if its archive copy is already linked); elsewhere it is deleted. Only a
 * message still filed under that folder counts: a move to another folder also leaves the old
 * one, and the new folder's delta files it.
 */
export function removeFromFolder(
	db: Queryable,
	mailboxId: string,
	folderId: string,
	graphId: string,
	now: number
): Removal {
	const message = db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, mailboxId),
				eq(messages.folderId, folderId),
				eq(messages.graphId, graphId),
				isNull(messages.deletedAt),
				isNull(messages.leftAt)
			)
		)
		.get();
	if (message === undefined) return 'none';
	const at = new Date(now);
	if (archiveOf(db, mailboxId) === null) {
		db.update(messages).set({ deletedAt: at }).where(eq(messages.id, message.id)).run();
		recordEvent(db, {
			messageId: message.id,
			mailboxId,
			at,
			kind: 'deleted',
			fromFolderPath: folderPath(db, folderId),
			toFolderPath: null
		});
		return 'deleted';
	}
	db.update(messages).set({ leftAt: at }).where(eq(messages.id, message.id)).run();
	const copy =
		message.archiveCopyId === null
			? undefined
			: db.select().from(messages).where(eq(messages.id, message.archiveCopyId)).get();
	if (copy !== undefined) {
		recordArchived(db, message, copy, at);
		return 'archived';
	}
	return 'left';
}

/** Messages that left a mailbox SETTLE_MS ago with no archive copy found: deleted, then. */
export function settleLeftMessages(db: Queryable, mailboxId: string, now: number): number {
	const due = db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, mailboxId),
				isNotNull(messages.leftAt),
				lt(messages.leftAt, new Date(now - SETTLE_MS)),
				isNull(messages.archiveCopyId),
				isNull(messages.deletedAt)
			)
		)
		.all();
	for (const message of due) {
		const at = message.leftAt ?? new Date(now);
		db.update(messages).set({ deletedAt: at }).where(eq(messages.id, message.id)).run();
		recordEvent(db, {
			messageId: message.id,
			mailboxId,
			at,
			kind: 'deleted',
			fromFolderPath: folderPath(db, message.folderId),
			toFolderPath: null
		});
	}
	return due.length;
}

/** The forms one Message-ID is stored in: as Microsoft gave it, with and without <>. */
function idForms(id: string): string[] {
	const bare = id.trim().replace(/^<|>$/g, '');
	return [...new Set([bare, `<${bare}>`, id.trim()])];
}

/**
 * Links a newly stored (or newly read) online archive item to the same email in its person's
 * mailbox, if there is one. Returns whether it linked.
 */
export function linkArchiveCopy(db: Queryable, archiveMessageId: string): boolean {
	const copy = db.select().from(messages).where(eq(messages.id, archiveMessageId)).get();
	if (copy === undefined || copy.internetMessageId === null || copy.receivedAt === null) {
		return false;
	}
	const archive = db.select().from(mailboxes).where(eq(mailboxes.id, copy.mailboxId)).get();
	if (archive?.kind !== 'archive') return false;
	const already = db
		.select({ id: messages.id })
		.from(messages)
		.where(eq(messages.archiveCopyId, copy.id))
		.get();
	if (already !== undefined) return false;
	const owners = db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(and(eq(mailboxes.userId, archive.userId), ne(mailboxes.kind, 'archive')))
		.all()
		.map((row) => row.id);
	if (owners.length === 0) return false;
	const received = copy.receivedAt.getTime();
	const candidates = db
		.select()
		.from(messages)
		.where(
			and(
				inArray(messages.mailboxId, owners),
				inArray(messages.internetMessageId, idForms(copy.internetMessageId)),
				gte(messages.receivedAt, new Date(received - RECEIVED_SLACK_MS)),
				lte(messages.receivedAt, new Date(received + RECEIVED_SLACK_MS)),
				isNull(messages.archiveCopyId)
			)
		)
		.orderBy(asc(messages.storedAt))
		.all();
	if (candidates.length === 0) return false;
	// An email sent to oneself is in Sent Items and the Inbox: the same folder name decides.
	const archivePath = folderPath(db, copy.folderId);
	const message =
		candidates.find((candidate) => folderPath(db, candidate.folderId) === archivePath) ??
		candidates[0];
	if (message === undefined) return false;
	// An earlier Lookstow took the move for a deletion: it left then.
	const leftAt = message.leftAt ?? message.deletedAt;
	db.update(messages)
		.set({ archiveCopyId: copy.id, leftAt, deletedAt: null })
		.where(eq(messages.id, message.id))
		.run();
	if (leftAt !== null) {
		if (message.deletedAt !== null) {
			// That "deleted" was the archive move: the record says so now.
			const wrong = db
				.select({ id: messageEvents.id })
				.from(messageEvents)
				.where(and(eq(messageEvents.messageId, message.id), eq(messageEvents.kind, 'deleted')))
				.orderBy(desc(messageEvents.at))
				.get();
			if (wrong !== undefined) {
				db.update(messageEvents)
					.set({ kind: 'archived', toFolderPath: `${ARCHIVE_PREFIX}/${archivePath ?? ''}` })
					.where(eq(messageEvents.id, wrong.id))
					.run();
			} else {
				recordArchived(db, message, copy, leftAt);
			}
		} else {
			recordArchived(db, message, copy, leftAt);
		}
	}
	return true;
}

/**
 * Links every stored archive item not yet linked (the upgrade pass, and a catch-up after the
 * .fts index has read older items). Idempotent; a batch at a time.
 */
export async function linkAllArchiveCopies(
	db: Queryable,
	stopping: () => boolean
): Promise<{ checked: number; linked: number }> {
	const archives = db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(eq(mailboxes.kind, 'archive'))
		.all()
		.map((row) => row.id);
	let checked = 0;
	let linked = 0;
	for (const archiveId of archives) {
		let after = '';
		for (;;) {
			if (stopping()) return { checked, linked };
			const batch = db
				.select({ id: messages.id })
				.from(messages)
				.where(
					and(
						eq(messages.mailboxId, archiveId),
						isNotNull(messages.internetMessageId),
						gt(messages.id, after)
					)
				)
				.orderBy(asc(messages.id))
				.limit(500)
				.all();
			if (batch.length === 0) break;
			for (const row of batch) {
				checked += 1;
				if (linkArchiveCopy(db, row.id)) linked += 1;
			}
			after = batch.at(-1)?.id ?? after;
			await new Promise((resolve) => {
				setImmediate(resolve);
			});
		}
	}
	return { checked, linked };
}

/** The other copy of an email, for the message page and the AI tools. */
export function otherCopyOf(
	db: Queryable,
	messageId: string
): { id: string; mailboxAddress: string; mailboxKind: string; folderPath: string } | null {
	const self = db.select().from(messages).where(eq(messages.id, messageId)).get();
	if (self === undefined) return null;
	const other =
		self.archiveCopyId === null
			? db.select().from(messages).where(eq(messages.archiveCopyId, self.id)).get()
			: db.select().from(messages).where(eq(messages.id, self.archiveCopyId)).get();
	if (other === undefined) return null;
	const mailbox = db.select().from(mailboxes).where(eq(mailboxes.id, other.mailboxId)).get();
	return {
		id: other.id,
		mailboxAddress: mailbox?.address ?? '',
		mailboxKind: mailbox?.kind ?? '',
		folderPath: folderPath(db, other.folderId) ?? ''
	};
}
