import { and, count, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { messageContent, messages } from '../../database/schema.ts';
import { errorText, serverLog } from '../../log.ts';
import { loadMessage } from './message-content.ts';
import type { ParsedMessage } from './mime.ts';

/**
 * The content index for the AI tools: each stored message's text and attachment summary, read
 * once from its file (mail .eml, or an archive item's .fts converted) and kept in
 * message_content, so search can filter by body words and attachments without opening files.
 * It runs in the background, newest messages first, a batch at a time, and catches up with new
 * messages every few minutes, while AI tools are turned on. Files are only read.
 */
export const CONTENT_VERSION = 1;
const TEXT_LIMIT = 20_000;
/** Pictures smaller than this are logos and icons, not photos of a timesheet. */
export const SMALL_PICTURE_BYTES = 30_000;
const BATCH = 100;
const REST_MS = 5 * 60_000;

export type AttachmentSummary = {
	index: number;
	filename: string;
	contentType: string;
	bytes: number;
	inline: boolean;
	insideAttachment: number | null;
};

export function summarise(parsed: ParsedMessage) {
	const attachments: AttachmentSummary[] = parsed.attachments.map((attachment) => ({
		index: attachment.index,
		filename: attachment.filename,
		contentType: attachment.contentType,
		bytes: attachment.data.length,
		inline: attachment.inline,
		insideAttachment: attachment.insideAttachment
	}));
	const real = attachments.filter(
		(attachment) =>
			!(attachment.contentType.startsWith('image/') && attachment.bytes < SMALL_PICTURE_BYTES)
	);
	return {
		text: parsed.text.slice(0, TEXT_LIMIT),
		attachmentCount: attachments.length,
		imageCount: real.filter((attachment) => attachment.contentType.startsWith('image/')).length,
		pdfCount: real.filter((attachment) => attachment.contentType === 'application/pdf').length,
		largestAttachmentBytes: real.reduce((most, attachment) => Math.max(most, attachment.bytes), 0),
		attachments
	};
}

export function saveContent(
	db: Queryable,
	messageId: string,
	parsed: ParsedMessage | { error: string },
	now: number
): void {
	const values =
		'error' in parsed
			? {
					text: '',
					attachmentCount: 0,
					imageCount: 0,
					pdfCount: 0,
					largestAttachmentBytes: 0,
					attachments: '[]',
					problem: parsed.error
				}
			: (() => {
					const summary = summarise(parsed);
					return { ...summary, attachments: JSON.stringify(summary.attachments), problem: null };
				})();
	const row = { ...values, version: CONTENT_VERSION, indexedAt: new Date(now) };
	db.insert(messageContent)
		.values({ messageId, ...row })
		.onConflictDoUpdate({ target: messageContent.messageId, set: row })
		.run();
}

/**
 * Messages with no content row from the current reader, most recently stored first, below a
 * cursor (the row number of the last one read). Walking the table's own order with a cursor
 * reads each row once; sorting the whole table by date for every batch held the server for
 * over 100 ms each time on a large backup.
 */
function unindexed(
	db: Queryable,
	limit: number,
	before: number | null
): { id: string; row: number }[] {
	const row = sql<number>`${messages}.rowid`;
	const pending = or(isNull(messageContent.messageId), lt(messageContent.version, CONTENT_VERSION));
	return db
		.select({ id: messages.id, row })
		.from(messages)
		.leftJoin(messageContent, eq(messageContent.messageId, messages.id))
		.where(before === null ? pending : and(pending, sql`${messages}.rowid < ${before}`))
		.orderBy(desc(row))
		.limit(limit)
		.all();
}

export function contentIndexProgress(db: Queryable): { indexed: number; total: number } {
	const total = db.select({ n: count() }).from(messages).get()?.n ?? 0;
	const indexed =
		db
			.select({ n: count() })
			.from(messageContent)
			.where(eq(messageContent.version, CONTENT_VERSION))
			.get()?.n ?? 0;
	return { indexed, total };
}

function pause(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

/** Reads every message not yet in the index; returns how many it read. */
export async function indexContent(
	db: Queryable,
	backupRoot: () => string,
	stopping: () => boolean,
	now: () => number = Date.now
): Promise<number> {
	let done = 0;
	let cursor: number | null = null;
	for (;;) {
		const batch = unindexed(db, BATCH, cursor);
		if (batch.length === 0 || stopping()) return done;
		cursor = batch.at(-1)?.row ?? cursor;
		for (const { id } of batch) {
			if (stopping()) return done;
			const loaded = await loadMessage(db, backupRoot(), id);
			saveContent(db, id, 'error' in loaded ? loaded : loaded.parsed, now());
			done += 1;
			await pause();
		}
	}
}

export type ContentIndexer = { stop: () => Promise<void> };

/** Keeps the index up to date in the background: catches up, rests, catches up again. */
export function startContentIndexer(
	db: Queryable,
	backupRoot: () => string,
	enabled: () => boolean
): ContentIndexer {
	const state: { stopping: boolean; running: Promise<void>; timer: NodeJS.Timeout | null } = {
		stopping: false,
		running: Promise.resolve(),
		timer: null
	};
	const run = (): void => {
		const work = enabled()
			? indexContent(db, backupRoot, () => state.stopping)
			: Promise.resolve(0);
		state.running = work
			.then((read) => {
				if (read > 0) serverLog('info', 'ai', `Content index: read ${String(read)} messages`);
			})
			.catch((error: unknown) => {
				serverLog('warn', 'ai', `Content index stopped: ${errorText(error)}`);
			})
			.finally(() => {
				if (!state.stopping) {
					state.timer = setTimeout(run, REST_MS);
					state.timer.unref();
				}
			});
	};
	state.timer = setTimeout(run, 30_000);
	state.timer.unref();
	return {
		stop: async () => {
			state.stopping = true;
			if (state.timer !== null) clearTimeout(state.timer);
			await state.running;
		}
	};
}
