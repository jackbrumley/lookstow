import { and, count, desc, eq, gt, gte, isNull, sql, type SQL } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, mailFolders, messageContent, messages } from '../../database/schema.ts';
import type { MessageHit, MessageQuery } from '../../../domain/messages.ts';
import { conditions, contains, hitColumns, toHit } from '../messages/search.ts';
import type { AttachmentSummary } from './content-index.ts';

/**
 * Search for the AI tools: the console's filters (mailbox, words, sender, recipient, subject,
 * folder, dates) plus the content index's (words in the body, photos, PDFs, attachment size).
 * Messages the content index has not read yet match no content filter; the reply says how far
 * the index has got.
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

function contentConditions(filters: ContentFilters): SQL[] {
	const all: SQL[] = [];
	for (const word of filters.body.split(/\s+/).filter((part) => part !== '')) {
		all.push(contains(messageContent.text, word));
	}
	if (filters.hasAttachments !== null) {
		all.push(
			filters.hasAttachments
				? gt(messageContent.attachmentCount, 0)
				: eq(messageContent.attachmentCount, 0)
		);
	}
	if (filters.hasPhotos !== null) {
		all.push(
			filters.hasPhotos ? gt(messageContent.imageCount, 0) : eq(messageContent.imageCount, 0)
		);
	}
	if (filters.hasPdf !== null) {
		all.push(filters.hasPdf ? gt(messageContent.pdfCount, 0) : eq(messageContent.pdfCount, 0));
	}
	if (filters.minAttachmentKb !== null) {
		all.push(gte(messageContent.largestAttachmentBytes, filters.minAttachmentKb * 1024));
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
	const where = and(...conditions(query), ...contentConditions(filters));
	const base = db
		.select({ total: count() })
		.from(messages)
		.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
		.leftJoin(messageContent, eq(messageContent.messageId, messages.id));
	const total = base.where(where).get()?.total ?? 0;
	// Of the messages the console's filters match, how many the content index has not read.
	const notIndexed =
		db
			.select({ total: count() })
			.from(messages)
			.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
			.leftJoin(messageContent, eq(messageContent.messageId, messages.id))
			.where(and(...conditions(query), isNull(messageContent.messageId)))
			.get()?.total ?? 0;
	const rows = db
		.select({
			...hitColumns,
			text: messageContent.text,
			attachments: messageContent.attachments,
			problem: messageContent.problem,
			indexed: sql<number>`${messageContent.messageId} is not null`
		})
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
		.leftJoin(messageContent, eq(messageContent.messageId, messages.id))
		.where(where)
		.orderBy(desc(messages.receivedAt))
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
		.leftJoin(messageContent, eq(messageContent.messageId, messages.id))
		.where(and(...conditions(query), ...contentConditions(filters)))
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
