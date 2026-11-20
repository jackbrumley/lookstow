import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle's view of the content file's plain tables (content-file.ts creates them; they are not
 * in schema.ts, so drizzle-kit never puts them in the main file). The full-text tables
 * content_headers and content_body are reached with SQL; their row number is a doc.
 */

/** One row per indexed message: its doc number, the row number in every content_* table. */
export const contentDocs = sqliteTable('content_docs', {
	doc: integer().primaryKey(),
	messageId: text().notNull().unique()
});

/**
 * What each stored message holds, read once from its file for the AI tools (docs/decisions.md,
 * "AI tools"): its text (invisible padding removed, at most CONTENT_TEXT_LIMIT characters) and a
 * summary of its attachments. `version` says which reader made the row, so a better reader reads
 * everything again.
 */
export const contentText = sqliteTable('content_text', {
	doc: integer().primaryKey(),
	version: integer().notNull(),
	text: text().notNull().default(''),
	attachmentCount: integer().notNull().default(0),
	imageCount: integer().notNull().default(0),
	pdfCount: integer().notNull().default(0),
	/** Bytes of the largest attachment that is not a small inline picture (a logo). */
	largestAttachmentBytes: integer().notNull().default(0),
	/** JSON: [{ index, filename, contentType, bytes, inline }] */
	attachments: text().notNull().default('[]'),
	/** Why the file could not be read, or null. */
	problem: text(),
	indexedAt: integer({ mode: 'timestamp_ms' }).notNull()
});
