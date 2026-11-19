import type { LogLine } from '../schemas/log.ts';

/**
 * The service log: one line per event on standard output, which the launcher sends to
 * journald (Linux) or server.log (Windows). `[time] LEVEL area: message`, so a line still
 * makes sense when copied out of context. The last lines are also kept in memory for the
 * console's Log page.
 */
export type LogLevel = 'info' | 'warn' | 'error';

const KEEP_LINES = 2000;
const recent: LogLine[] = [];
let lastSeq = 0;

export function serverLog(level: LogLevel, area: string, message: string): void {
	const at = new Date().toISOString();
	const line = `[${at}] ${level.toUpperCase()} ${area}: ${message}\n`;
	if (level === 'error') {
		process.stderr.write(line);
	} else {
		process.stdout.write(line);
	}
	lastSeq += 1;
	recent.push({ seq: lastSeq, at, level, area, message });
	if (recent.length > KEEP_LINES) {
		recent.splice(0, recent.length - KEEP_LINES);
	}
}

/** Lines after `afterSeq`, oldest first, at most `limit` (the newest ones when there are more). */
export function logSince(afterSeq: number, limit = 500): LogLine[] {
	const lines = recent.filter((line) => line.seq > afterSeq);
	return lines.slice(Math.max(0, lines.length - limit));
}

/** An error's message for a log line or the console, with its cause when it has one. */
export function errorText(error: unknown): string {
	if (error instanceof Error) {
		const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
		return `${error.message}${cause}`;
	}
	return String(error);
}
