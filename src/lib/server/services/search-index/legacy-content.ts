import { sql } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { ensureDoc } from './headers.ts';

/**
 * Before 0.13.0 the AI tools' content index (message_content) lived in the main file, where it
 * made up more than half of it. This moves its rows into the content file a batch at a time, so
 * nothing is read from the backup files again, deletes each batch from the main file as it goes,
 * and drops the empty table at the end. A batch is a few statements over a range of row numbers,
 * not a statement per message.
 *
 * Safe to stop at any point. The two files commit separately, so a crash between them can leave a
 * batch both moved and still in the old table: it is moved again (only into rows still waiting,
 * version 0), and its body index entries are replaced, never doubled.
 */
export function hasLegacyContent(db: Queryable): boolean {
	return (
		db.get<{ found: number } | undefined>(
			sql`select 1 as found from main.sqlite_master where type = 'table' and name = 'message_content'`
		) !== undefined
	);
}

/** Whether rows are still waiting to move. */
export function legacyContentLeft(db: Queryable): boolean {
	return (
		hasLegacyContent(db) &&
		db.get<{ found: number } | undefined>(
			sql`select 1 as found from main.message_content limit 1`
		) !== undefined
	);
}

/** Moves up to `limit` rows; returns how many, or null once the old table is gone. */
export function moveLegacyContent(db: Queryable, limit = 500): number | null {
	if (!hasLegacyContent(db)) return null;
	const range = db.get<{ first: number | null; last: number | null; rows: number }>(
		sql`select min(row) as first, max(row) as last, count(*) as rows from
			(select rowid as row from main.message_content order by rowid limit ${limit})`
	);
	const { first, last } = range;
	if (first === null || last === null) {
		db.run(sql`drop table main.message_content`);
		return null;
	}
	const inBatch = sql`m.rowid between ${first} and ${last}`;
	db.transaction((tx) => {
		// A message the header index has not reached yet gets its doc now.
		const missing = tx.all<{ messageId: string }>(
			sql`select m.message_id as messageId from main.message_content m
				left join content_docs d on d.message_id = m.message_id
				where ${inBatch} and d.doc is null`
		);
		for (const { messageId } of missing) ensureDoc(tx, messageId);
		// The docs this batch fills: those still waiting to be read.
		tx.run(sql`create temp table if not exists moving (doc integer primary key)`);
		tx.run(sql`delete from moving`);
		tx.run(
			sql`insert into moving (doc) select d.doc from main.message_content m
				join content_docs d on d.message_id = m.message_id
				join content_text t on t.doc = d.doc
				where ${inBatch} and +t.version = 0`
		);
		tx.run(
			sql`update content_text set version = m.version, text = m.text,
					attachment_count = m.attachment_count, image_count = m.image_count,
					pdf_count = m.pdf_count, largest_attachment_bytes = m.largest_attachment_bytes,
					attachments = m.attachments, problem = m.problem, indexed_at = m.indexed_at
				from main.message_content m join content_docs d on d.message_id = m.message_id
				where content_text.doc = d.doc and ${inBatch}
					and content_text.doc in (select doc from moving)`
		);
		tx.run(sql`delete from content_body where rowid in (select doc from moving)`);
		tx.run(
			sql`insert into content_body (rowid, text) select d.doc, m.text from main.message_content m
				join content_docs d on d.message_id = m.message_id
				where ${inBatch} and d.doc in (select doc from moving)`
		);
		tx.run(sql`delete from main.message_content where rowid between ${first} and ${last}`);
	});
	return range.rows;
}
