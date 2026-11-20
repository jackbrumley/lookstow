import type Database from 'better-sqlite3';
import { dirname, join } from 'node:path';

/**
 * The content file, `lookstow-content.db` beside `lookstow.db`, attached to every connection
 * as `content` (docs/specs/SPEC-SCALE.md). It holds only what Lookstow can build again from the
 * backup itself: the search index over subjects and addresses, and each message's text for the
 * AI tools. Keeping it out of the main file keeps the index, its daily snapshot and its backup
 * before an update small. Lost or from an older layout, it is emptied and built again.
 *
 * Its tables are named content_* so an unqualified name always finds them: SQLite looks in
 * main first, then in attached files.
 */
const CONTENT_LAYOUT = 1;

/** Where the content file lives for this index file; tests (`:memory:`) get one in memory. */
function contentPathFor(databasePath: string): string {
	return databasePath === ':memory:'
		? ':memory:'
		: join(dirname(databasePath), 'lookstow-content.db');
}

const TABLES = [
	`create table if not exists content.content_docs (
		doc integer primary key,
		message_id text not null unique
	)`,
	`create table if not exists content.content_text (
		doc integer primary key,
		version integer not null,
		text text not null default '',
		attachment_count integer not null default 0,
		image_count integer not null default 0,
		pdf_count integer not null default 0,
		largest_attachment_bytes integer not null default 0,
		attachments text not null default '[]',
		problem text,
		indexed_at integer not null
	)`,
	// Version 0 is a message waiting to be read: the reader finds them newest first by this index.
	'create index if not exists content.content_text_version on content_text (version, doc)',
	`create virtual table if not exists content.content_headers using fts5(
		subject, sender, recipients, content='', contentless_delete=1, tokenize='trigram', detail='none'
	)`,
	`create virtual table if not exists content.content_body using fts5(
		text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2', detail='none'
	)`,
	`create table if not exists content.content_meta (
		key text primary key,
		value integer not null
	)`
];

const DROP = [
	'drop table if exists content.content_docs',
	'drop table if exists content.content_text',
	'drop table if exists content.content_headers',
	'drop table if exists content.content_body',
	'drop table if exists content.content_meta'
];

/** Attaches the content file and makes sure it has the current layout. */
export function attachContentFile(client: Database.Database, databasePath: string): void {
	client.prepare('attach database ? as content').run(contentPathFor(databasePath));
	if (databasePath !== ':memory:') client.pragma('content.journal_mode = WAL');
	const layout = client.pragma('content.user_version', { simple: true });
	if (layout === CONTENT_LAYOUT) return;
	client.transaction(() => {
		if (layout !== 0) for (const statement of DROP) client.exec(statement);
		for (const statement of TABLES) client.exec(statement);
		client.pragma(`content.user_version = ${String(CONTENT_LAYOUT)}`);
	})();
}
