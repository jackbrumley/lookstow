import { and, asc, count, desc, eq, gte, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, mailFolders, messageEvents, messages } from '../../database/schema.ts';
import { otherCopyOf } from '../mailboxes/archive-links.ts';
import { headersCursor } from '../search-index/headers.ts';
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

/** The trigram index finds a part of a word only from three characters up. */
const SHORTEST_INDEXED = 3;

/** The three-character pieces of a typed text (the index folds their case as it does its own). */
function pieces(text: string): string[] {
	const characters = Array.from(text);
	const found = new Set<string>();
	for (let at = 0; at + SHORTEST_INDEXED <= characters.length; at += 1) {
		found.add(characters.slice(at, at + SHORTEST_INDEXED).join(''));
	}
	return [...found];
}

/**
 * The index query for a typed text: every three-character piece of it. The index keeps no
 * positions (a third of the size), so it names the messages holding all the pieces, and the
 * exact match is then checked on those alone.
 */
export function trigramQuery(text: string): string {
	return pieces(text)
		.map((piece) => `"${piece.replaceAll('"', '""')}"`)
		.join(' AND ');
}

/**
 * The index helps only when it narrows the search: when at most NARROW indexed messages match.
 * A text most messages hold (an address's domain, "re:") is found faster by walking the messages
 * newest first, where matches come thick and the first page fills at once.
 */
const NARROW = 5_000;

/** Whether the index narrows this text: it is asked, and stops counting past NARROW (a few ms). */
function narrows(db: Queryable, text: string): boolean {
	const found = db.get<{ n: number }>(
		sql`select count(*) as n from (select rowid from content_headers
			where content_headers match ${trigramQuery(text)} limit ${NARROW + 1})`
	).n;
	return found <= NARROW;
}

/**
 * One header filter: when the index narrows it, the messages the index names plus those stored
 * since it last ran (above `cursor`), each checked for the exact text; otherwise the exact check
 * alone. A null cursor means the index is not to be used.
 */
function headerMatch(
	db: Queryable,
	columns: readonly ('subject' | 'sender' | 'recipients')[],
	text: string,
	cursor: number | null
): { condition: SQL | undefined; indexed: boolean } {
	const exact = or(...columns.map((column) => contains(messages[column], text)));
	if (cursor === null || !indexable(text) || !narrows(db, text)) {
		return { condition: exact, indexed: false };
	}
	// Row numbers, so SQLite fetches the candidates directly instead of testing every message.
	return {
		condition: sql`(${messages}.rowid in (select m.rowid from content_docs d
			join content_headers h on h.rowid = d.doc join messages m on m.id = d.message_id
			where content_headers match ${trigramQuery(text)}
			union all select rowid from messages where rowid > ${cursor}) and ${exact})`,
		indexed: true
	};
}

function indexable(text: string): boolean {
	return Array.from(text).length >= SHORTEST_INDEXED;
}

/**
 * Newest first. A search the index narrowed sorts its matches; otherwise SQLite walks the date
 * index (in one mailbox or all) and stops after a page.
 */
export function newestFirst(indexed: boolean): SQL {
	return indexed ? sql`+${messages.receivedAt} desc` : desc(messages.receivedAt);
}

const ALL_HEADERS = ['subject', 'sender', 'recipients'] as const;

/** A complete Internet Message-ID (name@host.domain) is looked up; part of one is searched for. */
function messageIdMatch(typed: string): SQL {
	const id = typed.replace(/^<|>$/g, '');
	return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)
		? sql`${messages.internetMessageId} in (${id}, ${`<${id}>`})`
		: contains(messages.internetMessageId, id);
}

/** The search's conditions, and whether the search index narrowed it. */
export type SearchPlan = { where: SQL[]; indexed: boolean };

export function searchPlan(db: Queryable, query: MessageQuery): SearchPlan {
	const all: (SQL | undefined)[] = [];
	const cursor = headersCursor(db);
	// While many messages wait for the index (its first build after an update), the index
	// cannot narrow anything: every waiting message would be checked and sorted.
	const waiting =
		(db.get<{ top: number | null }>(sql`select max(rowid) as top from messages`).top ?? 0) - cursor;
	const useIndex = waiting <= NARROW;
	let indexed = false;
	const header = (columns: readonly ('subject' | 'sender' | 'recipients')[], text: string) => {
		const match = headerMatch(db, columns, text, useIndex ? cursor : null);
		indexed ||= match.indexed;
		all.push(match.condition);
	};
	if (query.mailboxId !== null) {
		all.push(eq(messages.mailboxId, query.mailboxId));
	}
	if (!query.includeDeleted) {
		all.push(isNull(messages.deletedAt));
	}
	// One email in two places is listed once, as its mailbox copy, unless an archive is searched
	// on its own (docs/specs/SPEC-ARCHIVE-LINKS.md).
	if (query.mailboxId === null) {
		all.push(
			sql`not exists (select 1 from messages as linked where linked.archive_copy_id = ${messages.id})`
		);
	}
	for (const word of query.text.split(/\s+/).filter((part) => part !== '')) {
		header(ALL_HEADERS, word);
	}
	if (query.from.trim() !== '') header(['sender'], query.from.trim());
	if (query.to.trim() !== '') header(['recipients'], query.to.trim());
	if (query.subject.trim() !== '') header(['subject'], query.subject.trim());
	if (query.folder.trim() !== '') all.push(contains(mailFolders.path, query.folder.trim()));
	if (query.messageId.trim() !== '') {
		all.push(messageIdMatch(query.messageId.trim()));
	}
	const after = dayStart(query.after);
	if (after !== null) all.push(gte(messages.receivedAt, after));
	const before = dayStart(query.before);
	if (before !== null) all.push(lt(messages.receivedAt, new Date(before.getTime() + 86_400_000)));
	return { where: all.filter((condition) => condition !== undefined), indexed };
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

/** The console counts a search's matches up to this many. */
export const COUNT_LIMIT = 5_000;

export function searchMessages(
	db: Queryable,
	query: MessageQuery,
	page: number
): { hits: MessageHit[]; total: number; more: boolean } {
	const plan = searchPlan(db, query);
	const where = and(...plan.where);
	// A search the index did not narrow may match most messages: counted up to COUNT_LIMIT.
	const matching = db
		.select({ one: sql`1` })
		.from(messages)
		.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
		.where(where);
	const counted =
		db
			.select({ total: count() })
			.from((plan.indexed ? matching : matching.limit(COUNT_LIMIT + 1)).as('matching'))
			.get()?.total ?? 0;
	const more = counted > COUNT_LIMIT;
	const total = more ? COUNT_LIMIT : counted;
	const hits = db
		.select(hitColumns)
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
		.where(where)
		.orderBy(newestFirst(plan.indexed))
		.limit(SEARCH_PAGE_SIZE)
		.offset(Math.max(0, page) * SEARCH_PAGE_SIZE)
		.all()
		.map(toHit);
	return { hits, total, more };
}

export function messageDetail(db: Queryable, id: string): MessageDetail | null {
	const row = db
		.select({
			...hitColumns,
			graphId: messages.graphId,
			internetMessageId: messages.internetMessageId,
			sha256: messages.sha256,
			filePath: messages.filePath,
			storedAt: messages.storedAt,
			leftAt: messages.leftAt
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
		leftAt: row.leftAt?.toISOString() ?? null,
		otherCopy: otherCopyOf(db, id),
		history
	};
}
