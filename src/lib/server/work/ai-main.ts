import { parentPort, type MessagePort } from 'node:worker_threads';
import { openDatabase } from '../database/connection.ts';
import { dataDir } from '../data-dir.ts';
import { env } from '../env.ts';
import { errorText, sendLogTo } from '../log.ts';
import { downloadAttachment, handleMcp } from '../services/ai/mcp.ts';
import { effectiveBackupRoot } from '../services/settings/settings.ts';
import { isToAi, type FromAi, type AiAnswer, type AiCall } from './ai-protocol.ts';

/**
 * The AI tools' thread (docs/specs/SPEC-SCALE.md): its own database connection, answering the
 * MCP endpoint's calls one at a time. An AI agent searching all day then holds only this thread,
 * never the backup engine's or the console's.
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

function context(baseUrl: string) {
	return {
		db,
		backupRoot: effectiveBackupRoot(db, folder),
		baseUrl,
		dataDir: folder,
		now: Date.now
	};
}

async function answer(call: AiCall): Promise<AiAnswer> {
	switch (call.name) {
		case 'mcp':
			return { name: 'mcp', value: await handleMcp(context(call.baseUrl), call.message) };
		case 'attachment': {
			const found = await downloadAttachment(context(call.baseUrl), call.messageId, call.index);
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
