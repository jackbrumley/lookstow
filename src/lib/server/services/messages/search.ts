import { and, asc, count, desc, eq, gte, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, mailFolders, messageEvents, messages } from '../../database/schema.ts';
import {
	SEARCH_PAGE_SIZE,
	type MessageDetail,
	type MessageHit,
	type MessageQuery
} from '../../../domain/messages.ts';

/**
 * Finding stored messages in the index: by mailbox, words in the subject, sender or recipients,
 * sender, recipient, subject, folder, Internet Message-ID and date. SQLite's LIKE matches
 * without regard to case for ASCII letters; `%` and `_` typed by someone are matched literally.
 * Message bodies are not indexed, and archive items carry no subject or addresses until they are
 * converted, so they are found by mailbox, folder and date.
 */
export function contains(column: SQLiteColumn, text: string): SQL {
	// SQLite has no default escape character for LIKE: name one (!), so a typed % or _ is literal.
	const escaped = text.replace(/[!%_]/g, (character) => `!${character}`);
	return sql`${column} like ${`%${escaped}%`} escape '!'`;
}

function dayStart(date: string): Date | null {
	const time = Date.parse(`${date}T00:00:00Z`);
	return Number.isNaN(time) ? null : new Date(time);
}

export function conditions(query: MessageQuery): SQL[] {
	const all: (SQL | undefined)[] = [];
	if (query.mailboxId !== null) {
		all.push(eq(messages.mailboxId, query.mailboxId));
	}
	if (!query.includeDeleted) {
		all.push(isNull(messages.deletedAt));
	}
	for (const word of query.text.split(/\s+/).filter((part) => part !== '')) {
		all.push(
			or(
				contains(messages.subject, word),
				contains(messages.sender, word),
				contains(messages.recipients, word)
			)
		);
	}
	if (query.from.trim() !== '') all.push(contains(messages.sender, query.from.trim()));
	if (query.to.trim() !== '') all.push(contains(messages.recipients, query.to.trim()));
	if (query.subject.trim() !== '') all.push(contains(messages.subject, query.subject.trim()));
	if (query.folder.trim() !== '') all.push(contains(mailFolders.path, query.folder.trim()));
	if (query.messageId.trim() !== '') {
		all.push(contains(messages.internetMessageId, query.messageId.trim().replace(/^<|>$/g, '')));
	}
	const after = dayStart(query.after);
	if (after !== null) all.push(gte(messages.receivedAt, after));
	const before = dayStart(query.before);
	if (before !== null) all.push(lt(messages.receivedAt, new Date(before.getTime() + 86_400_000)));
	return all.filter((condition) => condition !== undefined);
}

export const hitColumns = {
	id: messages.id,
	mailboxId: messages.mailboxId,
	mailboxAddress: mailboxes.address,
	mailboxKind: mailboxes.kind,
	folderPath: mailFolders.path,
	subject: messages.subject,
	sender: messages.sender,
	recipients: messages.recipients,
	receivedAt: messages.receivedAt,
	byteCount: messages.byteCount,
	deletedAt: messages.deletedAt
};

type HitRow = {
	id: string;
	mailboxId: string;
	mailboxAddress: string;
	mailboxKind: string;
	folderPath: string;
	subject: string;
	sender: string;
	recipients: string;
	receivedAt: Date | null;
	byteCount: number;
	deletedAt: Date | null;
};

export function toHit(row: HitRow): MessageHit {
	return {
		...row,
		receivedAt: row.receivedAt?.toISOString() ?? null,
		deletedAt: row.deletedAt?.toISOString() ?? null
	};
}

export function searchMessages(
	db: Queryable,
	query: MessageQuery,
	page: number
): { hits: MessageHit[]; total: number } {
	const where = and(...conditions(query));
	const total =
		db
			.select({ total: count() })
			.from(messages)
			.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
			.where(where)
			.get()?.total ?? 0;
	const hits = db
		.select(hitColumns)
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
		.where(where)
		.orderBy(desc(messages.receivedAt))
		.limit(SEARCH_PAGE_SIZE)
		.offset(Math.max(0, page) * SEARCH_PAGE_SIZE)
		.all()
		.map(toHit);
	return { hits, total };
}

export function messageDetail(db: Queryable, id: string): MessageDetail | null {
	const row = db
		.select({
			...hitColumns,
			graphId: messages.graphId,
			internetMessageId: messages.internetMessageId,
			sha256: messages.sha256,
			filePath: messages.filePath,
			storedAt: messages.storedAt
		})
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
		.where(eq(messages.id, id))
		.get();
	if (row === undefined) {
		return null;
	}
	const history = db
		.select()
		.from(messageEvents)
		.where(eq(messageEvents.messageId, id))
		.orderBy(asc(messageEvents.at))
		.all()
		.map((event) => ({
			at: event.at.toISOString(),
			kind: event.kind,
			fromFolderPath: event.fromFolderPath,
			toFolderPath: event.toFolderPath
		}));
	return {
		...toHit(row),
		graphId: row.graphId,
		internetMessageId: row.internetMessageId,
		sha256: row.sha256,
		filePath: row.filePath,
		storedAt: row.storedAt.toISOString(),
		history
	};
}
