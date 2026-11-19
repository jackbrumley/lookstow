import { count } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, messages } from '../../database/schema.ts';
import { SEARCH_PAGE_SIZE, type MessageQuery } from '../../../domain/messages.ts';
import { searchMessages } from '../messages/search.ts';
import { loadMessage, sha256Of, type LoadedMessage } from './message-content.ts';

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
	page: z.number().int().min(0).optional(),
	withContent: z.boolean().optional()
});

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
		description: `Finds stored messages, newest first, ${String(SEARCH_PAGE_SIZE)} a page. Filters: mailboxId (from list_mailboxes), text (words in subject, sender or recipients), from, to, subject, folder (path contains), after and before (yyyy-mm-dd, inclusive). Message bodies are not searched. withContent: true also reads each message and adds its attachments (name, type, size) and the first ${String(PREVIEW_CHARS)} characters of its text, for sorting candidates quickly. Online archive items stored before Lookstow 0.6 may have no subject or sender in the index: search them by mailbox, folder and date with withContent.`,
		inputSchema: {
			type: 'object',
			properties: {
				mailboxId: { type: 'string' },
				text: { type: 'string' },
				from: { type: 'string' },
				to: { type: 'string' },
				subject: { type: 'string' },
				folder: { type: 'string' },
				after: { type: 'string', description: 'yyyy-mm-dd' },
				before: { type: 'string', description: 'yyyy-mm-dd' },
				includeDeleted: {
					type: 'boolean',
					description: 'Include messages deleted in Microsoft 365'
				},
				page: { type: 'integer', minimum: 0 },
				withContent: { type: 'boolean' }
			}
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

function attachmentSummary(loaded: LoadedMessage) {
	return loaded.parsed.attachments.map((attachment) => ({
		index: attachment.index,
		filename: attachment.filename,
		contentType: attachment.contentType,
		bytes: attachment.data.length,
		inline: attachment.inline
	}));
}

async function search(
	context: ToolContext,
	input: z.infer<typeof searchInput>
): Promise<ToolResult> {
	const query: MessageQuery = {
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
	const page = input.page ?? 0;
	const { hits, total } = searchMessages(context.db, query, page);
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
			const loaded = await loadMessage(context.db, context.backupRoot, hit.id);
			results.push(
				'error' in loaded
					? { ...row, problem: loaded.error }
					: {
							...row,
							subject:
								row.subject === '' ? (loaded.parsed.headers.get('subject') ?? '') : row.subject,
							from: row.from === '' ? (loaded.parsed.headers.get('from') ?? '') : row.from,
							attachments: attachmentSummary(loaded),
							textStart: loaded.parsed.text.slice(0, PREVIEW_CHARS)
						}
			);
		} else {
			results.push(row);
		}
	}
	return text({
		total,
		page,
		pageSize: SEARCH_PAGE_SIZE,
		morePages: (page + 1) * SEARCH_PAGE_SIZE < total,
		messages: results
	});
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
			'Download it: curl -s -H "Authorization: Bearer <token>" -o <file> <url>, then open the file.'
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
