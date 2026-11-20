import type { McpReply } from '../services/ai/mcp.ts';
import type { LogLevel } from '../log.ts';
import type { AttachmentReply } from './protocol.ts';

/** What the web thread and the AI tools' thread say to each other (docs/specs/SPEC-SCALE.md). */
export type AiCall =
	| { name: 'mcp'; message: unknown; baseUrl: string }
	| { name: 'attachment'; messageId: string; index: number; baseUrl: string };

export type AiAnswer =
	{ name: 'mcp'; value: McpReply } | { name: 'attachment'; value: AttachmentReply };

export type ToAi = { type: 'call'; id: number; call: AiCall } | { type: 'stop' };

export type FromAi =
	| { type: 'started' }
	| { type: 'answer'; id: number; answer: AiAnswer }
	| { type: 'failed'; id: number; error: string }
	| { type: 'log'; level: LogLevel; area: string; message: string; at: string };

function typed(value: unknown, types: readonly string[]): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		typeof value.type === 'string' &&
		types.includes(value.type)
	);
}

export function isToAi(value: unknown): value is ToAi {
	return typed(value, ['call', 'stop']);
}

export function isFromAi(value: unknown): value is FromAi {
	return typed(value, ['started', 'answer', 'failed', 'log']);
}
