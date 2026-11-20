import { and, count, desc, eq, gt, gte, sql, type SQL } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { contentDocs, contentText } from '../../database/content-schema.ts';
import { mailboxes, mailFolders, messages } from '../../database/schema.ts';
import type { MessageHit, MessageQuery } from '../../../domain/messages.ts';
import { hitColumns, newestFirst, searchPlan, toHit } from '../messages/search.ts';
import { contentIndexProgress, type AttachmentSummary } from './content-index.ts';

/**
 * Search for the AI tools: the console's filters (mailbox, words, sender, recipient, subject,
 * folder, dates) plus the content index's (words in the body, photos, PDFs, attachment size).
 * Body words are looked up in the full-text index: a word matches words that start with it
 * ("timesheet" finds "timesheets"). Messages the content index has not read yet match no
 * content filter; the reply says how far the index has got.
 */
export type ContentFilters = {
	body: string;
	hasAttachments: boolean | null;
	hasPhotos: boolean | null;
	hasPdf: boolean | null;
	minAttachmentKb: number | null;
};

export type AiHit = MessageHit & {
	content: {
		text: string;
		attachments: AttachmentSummary[];
		problem: string | null;
	} | null;
};

/**
 * The words as an FTS5 query: every run of letters and digits in them, each of which may run on
 * ("time*"). The index keeps no positions, so "time-sheet" asks for both parts anywhere.
 */
function bodyQuery(body: string): string | null {
	const words = body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	if (words.length === 0) return null;
	return [...new Set(words)].map((word) => `"${word}"*`).join(' AND ');
}

/** Whether any content filter is set: they match only messages the content reader has read. */
function filtersContent(filters: ContentFilters): boolean {
	return (
		bodyQuery(filters.body) !== null ||
		filters.hasAttachments !== null ||
		filters.hasPhotos !== null ||
		filters.hasPdf !== null ||
		filters.minAttachmentKb !== null
	);
}

function contentConditions(filters: ContentFilters): SQL[] {
	const all: SQL[] = [];
	// A message not read yet has a waiting row (version 0) with nothing in it.
	if (filtersContent(filters)) all.push(gt(contentText.version, 0));
	const body = bodyQuery(filters.body);
	if (body !== null) {
		// Row numbers, so SQLite fetches the matches directly instead of testing every message.
		all.push(
			sql`${messages}.rowid in (select m.rowid from content_body b
				join content_docs d on d.doc = b.rowid join messages m on m.id = d.message_id
				where content_body match ${body})`
		);
	}
	if (filters.hasAttachments !== null) {
		all.push(
			filters.hasAttachments
				? gt(contentText.attachmentCount, 0)
				: eq(contentText.attachmentCount, 0)
		);
	}
	if (filters.hasPhotos !== null) {
		all.push(filters.hasPhotos ? gt(contentText.imageCount, 0) : eq(contentText.imageCount, 0));
	}
	if (filters.hasPdf !== null) {
		all.push(filters.hasPdf ? gt(contentText.pdfCount, 0) : eq(contentText.pdfCount, 0));
	}
	if (filters.minAttachmentKb !== null) {
		all.push(gte(contentText.largestAttachmentBytes, filters.minAttachmentKb * 1024));
	}
	return all;
}

function parseAttachments(json: string): AttachmentSummary[] {
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value.filter(isSummary) : [];
	} catch {
		return [];
	}
}

function isSummary(value: unknown): value is AttachmentSummary {
	return typeof value === 'object' && value !== null && 'index' in value && 'filename' in value;
}

export function aiSearch(
	db: Queryable,
	query: MessageQuery,
	filters: ContentFilters,
	page: number,
	pageSize: number
): { hits: AiHit[]; total: number; notIndexed: number } {
	const plan = searchPlan(db, query);
	const found = plan.where;
	const where = and(...found, ...contentConditions(filters));
	const total =
		db
			.select({ total: count() })
			.from(messages)
			.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
			.leftJoin(contentDocs, eq(contentDocs.messageId, messages.id))
			.leftJoin(contentText, eq(contentText.doc, contentDocs.doc))
			.where(where)
			.get()?.total ?? 0;
	// What content filters may still miss: the messages the content reader has not read yet.
	const progress = contentIndexProgress(db);
	const notIndexed = filtersContent(filters) ? Math.max(0, progress.total - progress.indexed) : 0;
	const rows = db
		.select({
			...hitColumns,
			text: contentText.text,
			attachments: contentText.attachments,
			problem: contentText.problem,
			indexed: sql<number>`coalesce(${contentText.version}, 0) > 0`
		})
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
		.leftJoin(contentDocs, eq(contentDocs.messageId, messages.id))
		.leftJoin(contentText, eq(contentText.doc, contentDocs.doc))
		.where(where)
		.orderBy(newestFirst(plan.indexed || bodyQuery(filters.body) !== null))
		.limit(pageSize)
		.offset(Math.max(0, page) * pageSize)
		.all();
	const hits = rows.map((row) => ({
		...toHit(row),
		content:
			row.indexed === 1
				? {
						text: row.text ?? '',
						attachments: parseAttachments(row.attachments ?? '[]'),
						problem: row.problem
					}
				: null
	}));
	return { hits, total, notIndexed };
}

/** Who sent the most messages matching the filters: for finding farm managers and farms. */
export function topSenders(
	db: Queryable,
	query: MessageQuery,
	filters: ContentFilters,
	limit: number
): { sender: string; messages: number; first: string | null; last: string | null }[] {
	return db
		.select({
			sender: messages.sender,
			messages: count(),
			first: sql<number | null>`min(${messages.receivedAt})`,
			last: sql<number | null>`max(${messages.receivedAt})`
		})
		.from(messages)
		.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
		.leftJoin(contentDocs, eq(contentDocs.messageId, messages.id))
		.leftJoin(contentText, eq(contentText.doc, contentDocs.doc))
		.where(and(...searchPlan(db, query).where, ...contentConditions(filters)))
		.groupBy(messages.sender)
		.orderBy(desc(count()))
		.limit(limit)
		.all()
		.map((row) => ({
			sender: row.sender,
			messages: row.messages,
			first: row.first === null ? null : new Date(row.first).toISOString(),
			last: row.last === null ? null : new Date(row.last).toISOString()
		}));
}
