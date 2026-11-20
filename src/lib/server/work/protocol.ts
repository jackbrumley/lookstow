import type { AlertRecipient, EmailView } from '../../domain/alerts.ts';
import type { LiveStatus } from '../../domain/live-status.ts';
import type { LearnedPace } from '../services/graph/governor.ts';
import type { McpReply } from '../services/ai/mcp.ts';
import type { NewActivity } from '../services/activity/activity.ts';
import type { LogLevel } from '../log.ts';
import type { SlowQuery } from '../database/slow-queries.ts';
import type { ThreadHealth } from './thread-health.ts';

/**
 * What the web thread and the work thread say to each other (docs/specs/SPEC-SCALE.md). The work
 * thread runs everything that reads or writes a lot: the backup engine, email alerts, the
 * throughput monitor, the search and content indexes, and the AI tools. The web thread answers
 * the console from its own connection and a snapshot of the engine the work thread sends every
 * second, so a busy engine never makes a page wait.
 *
 * Both ends are this program, so messages are checked by their `type` only.
 */
export type WorkSnapshot = {
	live: LiveStatus;
	learnedPace: LearnedPace;
	lockdown: string | null;
	slowQueries: SlowQuery[];
	health: ThreadHealth;
};

export type AttachmentReply =
	{ error: string } | { filename: string; contentType: string; data: Uint8Array };

export type WorkCall =
	| { name: 'requestDiscovery' }
	| { name: 'requestSync'; mailboxIds: string[] | null }
	| { name: 'cancel'; mailboxId: string }
	| { name: 'pause'; reason: 'manual' | 'disk'; actor: string; detail: string | null }
	| { name: 'resume'; actor: string }
	| { name: 'waitUntilIdle'; mailboxId: string; ms: number }
	| { name: 'startMove'; to: string; actor: string }
	| { name: 'cancelMove'; actor: string }
	| { name: 'removeOldCopy'; actor: string }
	| { name: 'forgetPace' }
	| { name: 'sendTestAlert'; recipient: AlertRecipient; by: string }
	| { name: 'mcp'; message: unknown; baseUrl: string }
	| { name: 'attachment'; messageId: string; index: number; baseUrl: string };

/** What each call answers; calls with nothing to say answer `done`. */
export type WorkAnswer =
	| { name: 'done' }
	| { name: 'idle'; value: boolean }
	| { name: 'testAlert'; value: EmailView | null }
	| { name: 'mcp'; value: McpReply }
	| { name: 'attachment'; value: AttachmentReply };

export type ToWork =
	| { type: 'call'; id: number; call: WorkCall }
	| { type: 'activity'; entry: NewActivity; now: number }
	| { type: 'stop' };

export type FromWork =
	| { type: 'snapshot'; snapshot: WorkSnapshot }
	| { type: 'answer'; id: number; answer: WorkAnswer; snapshot: WorkSnapshot | null }
	| { type: 'failed'; id: number; error: string; snapshot: WorkSnapshot | null }
	| { type: 'log'; level: LogLevel; area: string; message: string; at: string }
	| { type: 'started' }
	| { type: 'stopped' };

const TO_WORK = new Set(['call', 'activity', 'stop']);
const FROM_WORK = new Set(['snapshot', 'answer', 'failed', 'log', 'started', 'stopped']);

function typed(value: unknown, types: Set<string>): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		typeof value.type === 'string' &&
		types.has(value.type)
	);
}

export function isToWork(value: unknown): value is ToWork {
	return typed(value, TO_WORK);
}

export function isFromWork(value: unknown): value is FromWork {
	return typed(value, FROM_WORK);
}
