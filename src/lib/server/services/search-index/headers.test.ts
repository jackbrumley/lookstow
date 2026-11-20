import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { messages } from '../../database/schema.ts';
import { applyDiscovery, insertMessage, syncFolderList } from '../mailboxes/repository.ts';
import { docOf, indexNewHeaders, pruneContent } from './headers.ts';
import { hasLegacyContent, legacyContentLeft, moveLegacyContent } from './legacy-content.ts';

function seed(count: number) {
	const db = openDatabase(':memory:');
	const mailbox = applyDiscovery(
		db,
		[
			{
				userId: 'u',
				kind: 'user',
				address: 'ann@example.com',
				displayName: 'Ann',
				exchangeMailboxId: null
			}
		],
		1
	).added[0];
	if (mailbox === undefined) throw new Error('no mailbox');
	const folder = syncFolderList(
		db,
		mailbox.id,
		[{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' }],
		1
	)[0];
	if (folder === undefined) throw new Error('no folder');
	const ids = Array.from({ length: count }, (_, index) =>
		insertMessage(db, {
			mailboxId: mailbox.id,
			folderId: folder.id,
			graphId: `m${String(index)}`,
			internetMessageId: null,
			subject: `Message ${String(index)}`,
			sender: 'bob@example.com',
			recipients: 'ann@example.com',
			receivedAt: new Date(index),
			filePath: `ann@example.com/m${String(index)}.eml`,
			byteCount: 10,
			sha256: 'x',
			storedAt: new Date(index)
		})
	);
	return { db, ids };
}

const countOf = (db: ReturnType<typeof openDatabase>, table: string): number =>
	db.get<{ n: number }>(sql.raw(`select count(*) as n from ${table}`)).n;

describe('the search index', () => {
	it('indexes new messages in batches and walks again after row numbers go down', () => {
		const { db } = seed(5);
		expect(indexNewHeaders(db, 2)).toBe(2);
		expect(indexNewHeaders(db, 10)).toBe(3);
		expect(indexNewHeaders(db, 10)).toBe(0);
		// A compacted index: its row numbers start again lower; known docs are kept.
		db.run(sql`update content_meta set value = 1000 where key = 'headers_rowid'`);
		expect(indexNewHeaders(db, 10)).toBe(5);
		expect(countOf(db, 'content_docs')).toBe(5);
	});

	it('removes the entries of messages no longer stored', () => {
		const { db, ids } = seed(3);
		indexNewHeaders(db);
		const gone = ids[1] ?? '';
		db.delete(messages)
			.where(sql`${messages.id} = ${gone}`)
			.run();
		let after: number | null = 0;
		while (after !== null) after = pruneContent(db, after, 1);
		expect(docOf(db, gone)).toBeNull();
		expect(countOf(db, 'content_docs')).toBe(2);
	});

	it('moves text read by an older Lookstow out of the main file, then drops its table', () => {
		const { db, ids } = seed(3);
		for (const [index, id] of ids.entries()) {
			db.run(
				sql`insert into main.message_content (message_id, version, text, indexed_at)
					values (${id}, 1, ${`timesheet number ${String(index)}`}, 1)`
			);
		}
		expect(legacyContentLeft(db)).toBe(true);
		let moved = 0;
		for (;;) {
			const batch = moveLegacyContent(db, 2);
			if (batch === null) break;
			moved += batch;
		}
		expect(moved).toBe(3);
		expect(hasLegacyContent(db)).toBe(false);
		expect(countOf(db, 'content_text')).toBe(3);
		const found = db.all<{ doc: number }>(
			sql`select rowid as doc from content_body where content_body match ${'"timeshe"*'}`
		);
		expect(found).toHaveLength(3);
	});
});
