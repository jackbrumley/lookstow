import { sql } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';

/**
 * The search index over subjects, senders and recipients (docs/specs/SPEC-SCALE.md): an FTS5
 * table with the trigram tokenizer, so "part of a word or address" finds what LIKE '%…%' found,
 * by looking it up instead of reading every message. It lives in the content file; each indexed
 * message has a doc number (content_docs), the row number of its entry in every content table.
 *
 * New messages are indexed a batch at a time, in the order they were stored, up to a cursor (the
 * last messages row number done). Search reads messages above the cursor the old way, so a
 * message is found the moment it is stored.
 */
const CURSOR = 'headers_rowid';

export function metaValue(db: Queryable, key: string): number | null {
	return (
		db.get<{ value: number } | undefined>(sql`select value from content_meta where key = ${key}`)
			?.value ?? null
	);
}

export function setMetaValue(db: Queryable, key: string, value: number): void {
	db.run(
		sql`insert into content_meta (key, value) values (${key}, ${value})
			on conflict (key) do update set value = excluded.value`
	);
}

/** The highest messages row number whose headers are in the index. */
export function headersCursor(db: Queryable): number {
	return metaValue(db, CURSOR) ?? 0;
}

type HeaderRow = { row: number; id: string; subject: string; sender: string; recipients: string };

function addDoc(db: Queryable, message: HeaderRow): number | null {
	const created = db.get<{ doc: number } | undefined>(
		sql`insert into content_docs (message_id) values (${message.id})
			on conflict (message_id) do nothing returning doc`
	);
	if (created === undefined) return null;
	db.run(
		sql`insert into content_headers (rowid, subject, sender, recipients)
			values (${created.doc}, ${message.subject}, ${message.sender}, ${message.recipients})`
	);
	// Its text waits for the content reader (version 0: not read yet).
	db.run(sql`insert into content_text (doc, version, indexed_at) values (${created.doc}, 0, 0)`);
	return created.doc;
}

/** This message's doc number, or null when it is not indexed yet. */
export function docOf(db: Queryable, messageId: string): number | null {
	return (
		db.get<{ doc: number } | undefined>(
			sql`select doc from content_docs where message_id = ${messageId}`
		)?.doc ?? null
	);
}

/** Indexes up to `limit` messages stored since the last call; returns how many it read. */
export function indexNewHeaders(db: Queryable, limit = 250): number {
	let cursor = headersCursor(db);
	const top = db.get<{ top: number | null }>(sql`select max(rowid) as top from messages`).top ?? 0;
	// Row numbers went down (a compacted or restored index): walk every message again. Docs
	// already made are kept; only missing ones are added.
	if (top < cursor) cursor = 0;
	const rows = db.all<HeaderRow>(
		sql`select rowid as row, id, subject, sender, recipients from messages
			where rowid > ${cursor} order by rowid limit ${limit}`
	);
	const last = rows.at(-1);
	if (last === undefined) {
		if (cursor !== headersCursor(db)) setMetaValue(db, CURSOR, cursor);
		return 0;
	}
	db.transaction((tx) => {
		for (const row of rows) addDoc(tx, row);
		setMetaValue(tx, CURSOR, last.row);
	});
	return rows.length;
}

/**
 * After messages are deleted: SQLite gives a new row the highest row number plus one, so numbers
 * freed at the top are used again, possibly below the cursor. The next passes walk every message
 * again; docs already made are kept, and search does not use the index until they are done.
 */
export function restartHeaders(db: Queryable): void {
	setMetaValue(db, CURSOR, 0);
}

/** After a message's subject or addresses change (an archive item read later). */
export function refreshHeaders(
	db: Queryable,
	messageId: string,
	headers: { subject: string; sender: string; recipients: string }
): void {
	const doc = docOf(db, messageId);
	if (doc === null) return;
	db.run(sql`delete from content_headers where rowid = ${doc}`);
	db.run(
		sql`insert into content_headers (rowid, subject, sender, recipients)
			values (${doc}, ${headers.subject}, ${headers.sender}, ${headers.recipients})`
	);
}

/** A doc for this message, made (with its headers) when it has none; null if no such message. */
export function ensureDoc(db: Queryable, messageId: string): number | null {
	const doc = docOf(db, messageId);
	if (doc !== null) return doc;
	const message = db.get<HeaderRow | undefined>(
		sql`select rowid as row, id, subject, sender, recipients from messages where id = ${messageId}`
	);
	return message === undefined ? null : addDoc(db, message);
}

/**
 * Removes the index entries of messages no longer stored (a deleted backup), `limit` docs at a
 * time from `afterDoc`. Returns the last doc looked at, or null when the walk is done.
 */
export function pruneContent(db: Queryable, afterDoc: number, limit = 1000): number | null {
	const docs = db.all<{ doc: number; messageId: string }>(
		sql`select doc, message_id as messageId from content_docs
			where doc > ${afterDoc} order by doc limit ${limit}`
	);
	const last = docs.at(-1);
	if (last === undefined) return null;
	const gone = docs.filter(
		(entry) =>
			db.get<{ found: number } | undefined>(
				sql`select 1 as found from messages where id = ${entry.messageId}`
			) === undefined
	);
	if (gone.length > 0) {
		db.transaction((tx) => {
			for (const { doc } of gone) {
				tx.run(sql`delete from content_headers where rowid = ${doc}`);
				tx.run(sql`delete from content_body where rowid = ${doc}`);
				tx.run(sql`delete from content_text where doc = ${doc}`);
				tx.run(sql`delete from content_docs where doc = ${doc}`);
			}
		});
	}
	return last.doc;
}
