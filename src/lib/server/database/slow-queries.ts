import type Database from 'better-sqlite3';
import { serverLog } from '../log.ts';

/**
 * Every query that holds its thread for SLOW_QUERY_MS or more is noted (docs/specs/SPEC-SCALE.md):
 * kept in a short list that /api/throughput shows, and logged once per statement every
 * LOG_AGAIN_MS, so the next slowdown names the query that caused it. SQLite runs on the thread
 * that asks, so a slow query is time the console (or the engine) could not answer.
 */
export const SLOW_QUERY_MS = 100;
const KEEP = 30;
const LOG_AGAIN_MS = 10 * 60_000;

export type SlowQuery = { sql: string; ms: number; times: number; lastAt: string };

const noted = new Map<string, SlowQuery>();
const loggedAt = new Map<string, number>();

function short(source: string): string {
	return source.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function noteSlowQuery(source: string, ms: number, now = Date.now()): void {
	const sql = short(source);
	const earlier = noted.get(sql);
	noted.delete(sql);
	noted.set(sql, {
		sql,
		ms: Math.round(Math.max(ms, earlier?.ms ?? 0)),
		times: (earlier?.times ?? 0) + 1,
		lastAt: new Date(now).toISOString()
	});
	while (noted.size > KEEP) {
		const oldest = noted.keys().next().value;
		if (oldest === undefined) break;
		noted.delete(oldest);
	}
	if (now - (loggedAt.get(sql) ?? 0) >= LOG_AGAIN_MS) {
		loggedAt.set(sql, now);
		serverLog('warn', 'slow-query', `${String(Math.round(ms))} ms: ${sql}`);
	}
}

/** The slow queries noted on this thread, slowest first. */
export function slowQueries(): SlowQuery[] {
	return [...noted.values()].sort((a, b) => b.ms - a.ms);
}

const TIMED = ['run', 'get', 'all', 'iterate'] as const;

/** Times every statement this connection prepares from now on. */
export function timeQueries(client: Database.Database): void {
	const prepare = client.prepare.bind(client);
	Object.defineProperty(client, 'prepare', {
		configurable: true,
		writable: true,
		value: (source: string) => {
			const statement = prepare(source);
			for (const method of TIMED) {
				const original = statement[method].bind(statement);
				Object.defineProperty(statement, method, {
					configurable: true,
					writable: true,
					value: (...params: unknown[]) => {
						const started = performance.now();
						try {
							return original(...params);
						} finally {
							const ms = performance.now() - started;
							if (ms >= SLOW_QUERY_MS) noteSlowQuery(source, ms);
						}
					}
				});
			}
			return statement;
		}
	});
}
