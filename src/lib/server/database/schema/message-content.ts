import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { messages } from './mailboxes.ts';

/**
 * What each stored message holds, read once from its file for the AI tools (docs/decisions.md,
 * "AI tools"): its text (invisible padding removed, at most CONTENT_TEXT_LIMIT characters) and a
 * summary of its attachments, so search can filter by words in the body and by attachments
 * without reading thousands of files. Built in the background; `version` says which reader made
 * the row, so a better reader reads everything again.
 */
export const messageContent = sqliteTable(
	'message_content',
	{
		messageId: text()
			.primaryKey()
			.references(() => messages.id, { onDelete: 'cascade' }),
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
	},
	(table) => [index('message_content_images').on(table.imageCount, table.pdfCount)]
);
