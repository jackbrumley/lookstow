import { and, desc, eq, gte } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { runs } from '../../database/schema.ts';
import { failureKind, type FailureKind } from '../../../domain/failure-kind.ts';

/** When the latest run of this kind finished, from the runs table (for the engine's start). */
export function lastFinished(db: Queryable, kind: 'discovery' | 'sync'): number | null {
	const row = db
		.select({ finishedAt: runs.finishedAt })
		.from(runs)
		.where(eq(runs.kind, kind))
		.orderBy(desc(runs.finishedAt))
		.limit(1)
		.get();
	return row?.finishedAt?.getTime() ?? null;
}

/**
 * Mailboxes whose latest syncs failed, from the last day of runs: how many failed in a row and
 * the latest failure's kind, so a restart keeps each one's back-off.
 */
export function failingMailboxes(
	db: Queryable,
	now: number
): Map<string, { count: number; kind: FailureKind }> {
	const rows = db
		.select({ mailboxId: runs.mailboxId, outcome: runs.outcome, error: runs.error })
		.from(runs)
		.where(and(eq(runs.kind, 'sync'), gte(runs.startedAt, new Date(now - 24 * 3_600_000))))
		.orderBy(desc(runs.startedAt))
		.all();
	const failing = new Map<string, { count: number; kind: FailureKind }>();
	const settled = new Set<string>();
	for (const row of rows) {
		if (row.mailboxId === null || settled.has(row.mailboxId) || row.outcome === 'running') continue;
		if (row.outcome !== 'failed') {
			settled.add(row.mailboxId);
			continue;
		}
		const seen = failing.get(row.mailboxId);
		failing.set(row.mailboxId, {
			count: (seen?.count ?? 0) + 1,
			kind: seen?.kind ?? failureKind(row.error ?? '')
		});
	}
	return failing;
}
