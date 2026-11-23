import { parentPort, type MessagePort } from 'node:worker_threads';
import { openDatabase } from '../database/connection.ts';
import { dataDir } from '../data-dir.ts';
import { env } from '../env.ts';
import { errorText, sendLogTo } from '../log.ts';
import { downloadAttachment, handleMcp } from '../services/ai/mcp.ts';
import { loadMessage } from '../services/ai/message-content.ts';
import { parseEml, type ParsedMessage } from '../services/ai/mime.ts';
import { bodyDocument, viewOf } from '../services/viewer/view-message.ts';
import { effectiveBackupRoot } from '../services/settings/settings.ts';
import { PackBuilder } from '../services/evidence/builder.ts';
import { viewable } from '../services/viewer/heic.ts';
import { isToAi, type FromAi, type AiAnswer, type AiCall } from './ai-protocol.ts';

/**
 * The reading thread (docs/specs/SPEC-SCALE.md): its own database connection, answering the
 * MCP endpoint's calls and the console viewer's one at a time. An AI agent searching all day, or
 * a 70 MB email being opened, then holds only this thread, never the engine's or the console's.
 */
function aiPort(): MessagePort {
	if (parentPort === null) throw new Error('ai-main.ts runs on the AI thread only');
	return parentPort;
}
const port = aiPort();
const post = (message: FromAi): void => {
	port.postMessage(message);
};
sendLogTo((level, area, message, at) => {
	post({ type: 'log', level, area, message, at });
});

const db = openDatabase(env.databasePath);
const folder = dataDir();
/** Evidence packs are made here (docs/specs/SPEC-EVIDENCE-PACKS.md), one at a time. */
const packs = new PackBuilder({
	db,
	dataDir: folder,
	backupRoot: () => effectiveBackupRoot(db, folder)
});

function context(baseUrl: string, who: string) {
	return {
		who,
		db,
		backupRoot: effectiveBackupRoot(db, folder),
		baseUrl,
		dataDir: folder,
		now: Date.now,
		evidence: { builder: packs, dataDir: folder }
	};
}

/**
 * The last few messages read for the viewer, parsed: a message's page, its body and each of its
 * pictures ask for the same message one after another, and a large one is read only once.
 */
const recent = new Map<string, ParsedMessage>();
const RECENT_KEPT = 4;

async function viewed(
	messageId: string,
	part: number | null
): Promise<ParsedMessage | { error: string }> {
	const key = `${messageId}#${String(part)}`;
	const kept = recent.get(key);
	if (kept !== undefined) return kept;
	const loaded = await loadMessage(db, effectiveBackupRoot(db, folder), messageId);
	if ('error' in loaded) return loaded;
	let parsed = loaded.parsed;
	if (part !== null) {
		const forwarded = parsed.attachments[part];
		if (forwarded?.contentType !== 'message/rfc822') {
			return { error: 'That part is not a forwarded email' };
		}
		parsed = parseEml(forwarded.data);
	}
	recent.set(key, parsed);
	while (recent.size > RECENT_KEPT) {
		const oldest = recent.keys().next().value;
		if (oldest === undefined) break;
		recent.delete(oldest);
	}
	return parsed;
}

async function answer(call: AiCall): Promise<AiAnswer> {
	switch (call.name) {
		case 'mcp':
			return { name: 'mcp', value: await handleMcp(context(call.baseUrl, call.who), call.message) };
		case 'view': {
			const parsed = await viewed(call.messageId, call.part);
			return { name: 'view', value: 'error' in parsed ? parsed : { view: viewOf(parsed) } };
		}
		case 'body': {
			const parsed = await viewed(call.messageId, call.part);
			return {
				name: 'body',
				value: 'error' in parsed ? parsed : { document: bodyDocument(parsed) }
			};
		}
		case 'part': {
			const parsed = await viewed(call.messageId, call.part);
			if ('error' in parsed) return { name: 'part', value: parsed };
			const attachment = parsed.attachments[call.index];
			if (attachment === undefined) return { name: 'part', value: { error: 'No such attachment' } };
			// Viewing a HEIC photo sends a JPEG copy; a download is always the original.
			const sent = call.asPicture
				? await viewable(`${call.messageId}#${String(call.part)}#${String(call.index)}`, attachment)
				: attachment;
			return {
				name: 'part',
				value: {
					filename: sent.filename,
					contentType: sent.contentType,
					data: new Uint8Array(sent.data)
				}
			};
		}
		case 'pack':
			await packs.enqueue(call.packId);
			return { name: 'pack', value: null };
		case 'attachment': {
			const found = await downloadAttachment(
				context(call.baseUrl, call.who),
				call.messageId,
				call.index
			);
			return {
				name: 'attachment',
				value:
					'error' in found
						? found
						: {
								filename: found.filename,
								contentType: found.contentType,
								data: new Uint8Array(found.data)
							}
			};
		}
	}
}

/** One call at a time, in the order they came. */
let turn: Promise<void> = Promise.resolve();

port.on('message', (message: unknown) => {
	if (!isToAi(message)) return;
	if (message.type === 'stop') {
		void turn.finally(() => {
			db.$client.close();
			sendLogTo(null);
			port.close();
		});
		return;
	}
	const { id, call } = message;
	turn = turn.then(() =>
		answer(call).then(
			(reply) => {
				post({ type: 'answer', id, answer: reply });
			},
			(error: unknown) => {
				post({ type: 'failed', id, error: errorText(error) });
			}
		)
	);
});

post({ type: 'started' });
