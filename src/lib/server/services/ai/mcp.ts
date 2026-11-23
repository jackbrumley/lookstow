import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { errorText, serverLog } from '../../log.ts';
import { APP_VERSION } from '../../../utils/app-version.ts';
import { attachmentBytes, callTool, TOOLS, type ToolContext } from './tools.ts';

/**
 * The Model Context Protocol endpoint (Streamable HTTP, JSON replies): an AI agent such as
 * Claude Code connects to http://127.0.0.1:8030/mcp with the access token and gets the tools in
 * tools.ts. Each tool call is written to an audit log (one JSON line per call, one file a day in
 * the data folder's ai-audit folder), so it is known afterwards which messages an agent opened.
 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const AUDIT_FOLDER = 'ai-audit';

const INSTRUCTIONS = `Lookstow is a backup of Microsoft 365 mailboxes and online archives. These tools only read it (evidence packs are copies of messages).
Start with list_mailboxes, then search_messages (filters by mailbox, sender, recipient, subject, folder and date; withContent adds attachments and the start of the text). Open a candidate with get_message and look at an attachment with get_attachment.
Record findings by message id, attachment index and SHA-256: they identify exactly what was looked at.
To hand messages to a lawyer, create_evidence_pack with their ids makes one ZIP file in the background; get_evidence_pack gives its progress and, when ready, its download URL.`;

type JsonRpcRequest = {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: unknown;
};

export type McpReply = { status: number; body: unknown };

function isRequest(value: unknown): value is JsonRpcRequest {
	return (
		typeof value === 'object' &&
		value !== null &&
		'method' in value &&
		typeof value.method === 'string'
	);
}

function paramsOf(request: JsonRpcRequest): Record<string, unknown> {
	const params = request.params;
	if (typeof params !== 'object' || params === null) return {};
	return Object.fromEntries(Object.entries(params));
}

function result(id: JsonRpcRequest['id'], value: unknown): McpReply {
	return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result: value } };
}

function failure(id: JsonRpcRequest['id'], code: number, message: string): McpReply {
	return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

async function audit(dataDir: string, entry: Record<string, unknown>, now: number): Promise<void> {
	try {
		const folder = join(dataDir, AUDIT_FOLDER);
		await mkdir(folder, { recursive: true });
		const day = new Date(now).toISOString().slice(0, 10);
		await appendFile(
			join(folder, `${day}.jsonl`),
			`${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`,
			{ mode: 0o600 }
		);
	} catch (error) {
		serverLog('warn', 'ai', `Could not write the AI audit log: ${errorText(error)}`);
	}
}

export async function handleMcp(
	context: ToolContext & { dataDir: string; now: () => number },
	message: unknown
): Promise<McpReply> {
	if (!isRequest(message)) {
		return {
			status: 400,
			body: {
				jsonrpc: '2.0',
				id: null,
				error: { code: -32600, message: 'Send one JSON-RPC request' }
			}
		};
	}
	// A notification (no id) needs no answer.
	if (message.id === undefined) return { status: 202, body: null };
	const params = paramsOf(message);
	switch (message.method) {
		case 'initialize': {
			const asked = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
			return result(message.id, {
				protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
				capabilities: { tools: {} },
				serverInfo: { name: 'lookstow', version: APP_VERSION },
				instructions: INSTRUCTIONS
			});
		}
		case 'ping':
			return result(message.id, {});
		case 'tools/list':
			return result(message.id, { tools: TOOLS });
		case 'tools/call': {
			const name = typeof params['name'] === 'string' ? params['name'] : '';
			const args = params['arguments'] ?? {};
			const started = context.now();
			try {
				const output = await callTool(context, name, args);
				await audit(
					context.dataDir,
					{ tool: name, arguments: args, ok: output.isError !== true, ms: context.now() - started },
					started
				);
				return result(message.id, output);
			} catch (error) {
				await audit(
					context.dataDir,
					{ tool: name, arguments: args, ok: false, error: errorText(error) },
					started
				);
				return result(message.id, {
					content: [{ type: 'text', text: `Lookstow could not answer: ${errorText(error)}` }],
					isError: true
				});
			}
		}
		default:
			return failure(message.id, -32601, `Lookstow has no method ${message.method}`);
	}
}

/** An attachment's bytes for its download URL, written to the audit log like a tool call. */
export async function downloadAttachment(
	context: ToolContext & { dataDir: string; now: () => number },
	messageId: string,
	index: number
): ReturnType<typeof attachmentBytes> {
	const found = await attachmentBytes(context, messageId, index);
	await audit(
		context.dataDir,
		{ download: { messageId, index }, ok: !('error' in found) },
		context.now()
	);
	return found;
}
