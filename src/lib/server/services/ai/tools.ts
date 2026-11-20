import { count } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, messages } from '../../database/schema.ts';
import type { MessageQuery } from '../../../domain/messages.ts';
import {
	contentIndexProgress,
	saveContent,
	SMALL_PICTURE_BYTES,
	summarise
} from './content-index.ts';
import { loadMessage, sha256Of } from './message-content.ts';
import { aiSearch, topSenders, type AiHit, type ContentFilters } from './search.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * The AI tools (served over MCP at /mcp): read-only access to the backed-up mail, so an agent
 * can find messages, read them and look at their attachments. Every message and attachment is
 * named by Lookstow's id and its SHA-256, so what an agent records can be traced back and
 * checked against the backup. Nothing here changes the backup or the index.
 */
type ToolContent =
	{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type ToolContext = { db: Queryable; backupRoot: string; baseUrl: string };

/** Images up to this size come back inline; bigger ones are fetched from their URL. */
const INLINE_IMAGE_BYTES = 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_LIMIT = 50_000;
const PREVIEW_CHARS = 300;

const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd')
	.optional();

const searchInput = z.object({
	mailboxId: z.string().optional(),
	text: z.string().optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	subject: z.string().optional(),
	folder: z.string().optional(),
	after: date,
	before: date,
	includeDeleted: z.boolean().optional(),
	body: z.string().optional(),
	hasAttachments: z.boolean().optional(),
	hasPhotos: z.boolean().optional(),
	hasPdf: z.boolean().optional(),
	minAttachmentKb: z.number().min(0).optional(),
	page: z.number().int().min(0).optional(),
	pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
	withContent: z.boolean().optional()
});

const sendersInput = searchInput.extend({ limit: z.number().int().min(1).max(500).optional() });

const FILTER_PROPERTIES = {
	mailboxId: { type: 'string' },
	text: { type: 'string', description: 'Words in the subject, sender or recipients' },
	from: { type: 'string' },
	to: { type: 'string' },
	subject: { type: 'string' },
	folder: { type: 'string', description: 'Folder path contains' },
	after: { type: 'string', description: 'yyyy-mm-dd, inclusive' },
	before: { type: 'string', description: 'yyyy-mm-dd, inclusive' },
	includeDeleted: { type: 'boolean', description: 'Include messages deleted in Microsoft 365' },
	body: { type: 'string', description: 'Words in the message text (content index)' },
	hasAttachments: { type: 'boolean' },
	hasPhotos: {
		type: 'boolean',
		description: `Has a picture of ${String(SMALL_PICTURE_BYTES / 1000)} KB or more (logos excluded)`
	},
	hasPdf: { type: 'boolean' },
	minAttachmentKb: { type: 'number', description: 'Largest real attachment at least this big' }
} as const;

const messageInput = z.object({ messageId: z.string().min(1) });
const attachmentInput = z.object({ messageId: z.string().min(1), index: z.number().int().min(0) });

export const TOOLS = [
	{
		name: 'list_mailboxes',
		description:
			'Every backed-up mailbox and online archive: its id (for search_messages), address, name, kind and how many messages are stored.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'search_messages',
		description: `Finds stored messages, newest first (pageSize up to ${String(MAX_PAGE_SIZE)}, default ${String(DEFAULT_PAGE_SIZE)}). Filters: mailboxId (from list_mailboxes), text (words in subject, sender or recipients), from, to, subject, folder, after and before (yyyy-mm-dd, inclusive); and from the content index: body (words in the message text; a word also finds words it starts, so timesheet finds timesheets), hasAttachments, hasPhotos (pictures of ${String(SMALL_PICTURE_BYTES / 1000)} KB or more, so not logos), hasPdf, minAttachmentKb. Content filters match only messages the index has read: the reply's contentIndex says how far it has got, and notIndexed (when content filters are used) how many messages it has not read yet, which those filters cannot match yet. withContent: true adds each message's attachments (name, type, size) and the first ${String(PREVIEW_CHARS)} characters of its text. An email in both a mailbox and its online archive (moved there by the archive policy) is listed once, as the mailbox copy, unless you search the archive by its own mailboxId; get_message names the other copy.`,
		inputSchema: {
			type: 'object',
			properties: {
				...FILTER_PROPERTIES,
				page: { type: 'integer', minimum: 0 },
				pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
				withContent: { type: 'boolean' }
			}
		}
	},
	{
		name: 'top_senders',
		description:
			'Who sent the most messages matching the same filters as search_messages (for example to payroll@ with photos), with their first and last message dates. For finding every farm manager and farm mailbox that sent timesheets.',
		inputSchema: {
			type: 'object',
			properties: { ...FILTER_PROPERTIES, limit: { type: 'integer', minimum: 1, maximum: 500 } }
		}
	},
	{
		name: 'get_message',
		description:
			'One message in full: its headers, where it is filed, the SHA-256 of its stored file, its text, and its attachments (index, name, type, size, SHA-256). Use get_attachment with the index to look at one.',
		inputSchema: {
			type: 'object',
			properties: { messageId: { type: 'string' } },
			required: ['messageId']
		}
	},
	{
		name: 'get_attachment',
		description: `One attachment of a message. A PNG, JPEG, GIF or WebP image up to ${String(INLINE_IMAGE_BYTES / 1024 / 1024)} MB comes back as an image you can see. Anything else (larger photos, PDFs, HEIC, Office files) comes back as a URL: download it with curl, sending the same Authorization header, then open the file.`,
		inputSchema: {
			type: 'object',
			properties: {
				messageId: { type: 'string' },
				index: { type: 'integer', minimum: 0 }
			},
			required: ['messageId', 'index']
		}
	}
] as const;

function text(value: unknown): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

function attachmentUrl(baseUrl: string, messageId: string, index: number): string {
	return `${baseUrl}/mcp/attachments/${encodeURIComponent(messageId)}/${String(index)}`;
}

function listMailboxes(db: Queryable): ToolResult {
	const counts = new Map(
		db
			.select({ mailboxId: messages.mailboxId, stored: count() })
			.from(messages)
			.groupBy(messages.mailboxId)
			.all()
			.map((row) => [row.mailboxId, row.stored])
	);
	return text(
		db
			.select()
			.from(mailboxes)
			.orderBy(mailboxes.address, mailboxes.kind)
			.all()
			.map((row) => ({
				id: row.id,
				address: row.address,
				name: row.displayName,
				kind: row.kind,
				gone: row.goneAt !== null,
				storedMessages: counts.get(row.id) ?? 0
			}))
	);
}

function queryOf(input: z.infer<typeof searchInput>): MessageQuery {
	return {
		mailboxId: input.mailboxId ?? null,
		text: input.text ?? '',
		from: input.from ?? '',
		to: input.to ?? '',
		subject: input.subject ?? '',
		folder: input.folder ?? '',
		messageId: '',
		after: input.after ?? '',
		before: input.before ?? '',
		includeDeleted: input.includeDeleted ?? false
	};
}

function filtersOf(input: z.infer<typeof searchInput>): ContentFilters {
	return {
		body: input.body ?? '',
		hasAttachments: input.hasAttachments ?? null,
		hasPhotos: input.hasPhotos ?? null,
		hasPdf: input.hasPdf ?? null,
		minAttachmentKb: input.minAttachmentKb ?? null
	};
}

/** A hit's text and attachments: from the content index, or read now (and indexed) if new. */
async function contentOf(context: ToolContext, hit: AiHit) {
	if (hit.content !== null) return hit.content;
	const loaded = await loadMessage(context.db, context.backupRoot, hit.id);
	saveContent(context.db, hit.id, 'error' in loaded ? loaded : loaded.parsed, Date.now());
	if ('error' in loaded) return { text: '', attachments: [], problem: loaded.error };
	const summary = summarise(loaded.parsed);
	return { text: summary.text, attachments: summary.attachments, problem: null };
}

async function search(
	context: ToolContext,
	input: z.infer<typeof searchInput>
): Promise<ToolResult> {
	const page = input.page ?? 0;
	const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
	const { hits, total, notIndexed } = aiSearch(
		context.db,
		queryOf(input),
		filtersOf(input),
		page,
		pageSize
	);
	const results = [];
	for (const hit of hits) {
		const row = {
			id: hit.id,
			mailbox: hit.mailboxAddress,
			mailboxKind: hit.mailboxKind,
			folder: hit.folderPath,
			receivedAt: hit.receivedAt,
			from: hit.sender,
			to: hit.recipients,
			subject: hit.subject,
			bytes: hit.byteCount,
			deletedInMicrosoft365: hit.deletedAt
		};
		if (input.withContent === true) {
			const content = await contentOf(context, hit);
			results.push({
				...row,
				attachments: content.attachments,
				textStart: content.text.slice(0, PREVIEW_CHARS),
				...(content.problem === null ? {} : { problem: content.problem })
			});
		} else {
			results.push(row);
		}
	}
	return text({
		total,
		page,
		pageSize,
		morePages: (page + 1) * pageSize < total,
		contentIndex: contentIndexProgress(context.db),
		notIndexed,
		messages: results
	});
}

function senders(context: ToolContext, input: z.infer<typeof sendersInput>): ToolResult {
	return text(topSenders(context.db, queryOf(input), filtersOf(input), input.limit ?? 100));
}

async function getMessage(context: ToolContext, messageId: string): Promise<ToolResult> {
	const loaded = await loadMessage(context.db, context.backupRoot, messageId);
	if ('error' in loaded) return failure(loaded.error);
	const { detail, parsed } = loaded;
	const header = (name: string) => parsed.headers.get(name) ?? null;
	return text({
		id: detail.id,
		mailbox: detail.mailboxAddress,
		mailboxKind: detail.mailboxKind,
		folder: detail.folderPath,
		receivedAt: detail.receivedAt,
		storedFile: detail.filePath,
		storedFileSha256: detail.sha256,
		internetMessageId: detail.internetMessageId,
		deletedInMicrosoft365: detail.deletedAt,
		leftMailboxAt: detail.leftAt,
		otherCopy: detail.otherCopy,
		headers: {
			from: header('from'),
			to: header('to'),
			cc: header('cc'),
			date: header('date'),
			subject: header('subject')
		},
		text:
			parsed.text.length > TEXT_LIMIT
				? `${parsed.text.slice(0, TEXT_LIMIT)}\n[… ${String(parsed.text.length - TEXT_LIMIT)} more characters]`
				: parsed.text,
		attachments: parsed.attachments.map((attachment) => ({
			index: attachment.index,
			filename: attachment.filename,
			contentType: attachment.contentType,
			bytes: attachment.data.length,
			sha256: sha256Of(attachment.data),
			inline: attachment.inline,
			insideAttachment: attachment.insideAttachment,
			url: attachmentUrl(context.baseUrl, detail.id, attachment.index)
		})),
		folderHistory: detail.history
	});
}

async function getAttachment(
	context: ToolContext,
	messageId: string,
	index: number
): Promise<ToolResult> {
	const loaded = await loadMessage(context.db, context.backupRoot, messageId);
	if ('error' in loaded) return failure(loaded.error);
	const attachment = loaded.parsed.attachments[index];
	if (attachment === undefined) {
		return failure(
			`Message ${messageId} has ${String(loaded.parsed.attachments.length)} attachments (index from 0).`
		);
	}
	const facts = {
		messageId,
		index,
		filename: attachment.filename,
		contentType: attachment.contentType,
		bytes: attachment.data.length,
		sha256: sha256Of(attachment.data),
		url: attachmentUrl(context.baseUrl, messageId, index)
	};
	if (
		INLINE_IMAGE_TYPES.has(attachment.contentType) &&
		attachment.data.length <= INLINE_IMAGE_BYTES
	) {
		return {
			content: [
				{ type: 'text', text: JSON.stringify(facts, null, 2) },
				{
					type: 'image',
					data: attachment.data.toString('base64'),
					mimeType: attachment.contentType
				}
			]
		};
	}
	return text({
		...facts,
		howToOpen:
			'Download it: curl -s -H "Authorization: Bearer <token>" -o <file> <url>, then open the file. A HEIC photo (or any photo too big to view) can be turned into a JPEG first, for example with ImageMagick: magick <file> -auto-orient -resize 2000x2000> <file>.jpg'
	});
}

/** Runs one tool call; bad arguments and unknown tools come back as tool errors. */
export async function callTool(
	context: ToolContext,
	name: string,
	args: unknown
): Promise<ToolResult> {
	switch (name) {
		case 'list_mailboxes':
			return listMailboxes(context.db);
		case 'search_messages': {
			const input = searchInput.safeParse(args ?? {});
			if (!input.success) return failure(input.error.issues[0]?.message ?? 'Bad arguments');
			return search(context, input.data);
		}
		case 'top_senders': {
			const input = sendersInput.safeParse(args ?? {});
			if (!input.success) return failure(input.error.issues[0]?.message ?? 'Bad arguments');
			return senders(context, input.data);
		}
		case 'get_message': {
			const input = messageInput.safeParse(args);
			if (!input.success) return failure('Give messageId');
			return getMessage(context, input.data.messageId);
		}
		case 'get_attachment': {
			const input = attachmentInput.safeParse(args);
			if (!input.success) return failure('Give messageId and index');
			return getAttachment(context, input.data.messageId, input.data.index);
		}
		default:
			return failure(`No tool named ${name}`);
	}
}

/** One attachment's bytes, for the download URL. */
export async function attachmentBytes(
	context: ToolContext,
	messageId: string,
	index: number
): Promise<{ filename: string; contentType: string; data: Buffer } | { error: string }> {
	const loaded = await loadMessage(context.db, context.backupRoot, messageId);
	if ('error' in loaded) return loaded;
	const attachment = loaded.parsed.attachments[index];
	if (attachment === undefined) return { error: 'No such attachment' };
	return {
		filename: attachment.filename,
		contentType: attachment.contentType,
		data: attachment.data
	};
}
