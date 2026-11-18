import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { activity } from '../../database/schema.ts';
import { serverLog } from '../../log.ts';
import type { ActivityEntry, ActivityLevel } from '../../../domain/activity.ts';

/** The activity log: what happened, in plain words. Every entry also goes to the service log. */
export type NewActivity = {
	level: ActivityLevel;
	kind: string;
	actor: string;
	summary: string;
	detail?: string | null;
	mailboxId?: string | null;
};

export function recordActivity(db: Queryable, entry: NewActivity, now = Date.now()): void {
	db.insert(activity)
		.values({
			id: randomUUID(),
			at: new Date(now),
			level: entry.level,
			kind: entry.kind,
			actor: entry.actor,
			summary: entry.summary,
			detail: entry.detail ?? null,
			mailboxId: entry.mailboxId ?? null
		})
		.run();
	const detail = entry.detail === undefined || entry.detail === null ? '' : ` (${entry.detail})`;
	serverLog(entry.level, entry.kind, `${entry.summary}${detail}`);
}

export function listActivity(
	db: Queryable,
	options: { limit: number; before?: number; level?: ActivityLevel; mailboxId?: string }
): ActivityEntry[] {
	const conditions = [
		options.before === undefined ? undefined : lt(activity.at, new Date(options.before)),
		options.level === undefined ? undefined : eq(activity.level, options.level),
		options.mailboxId === undefined ? undefined : eq(activity.mailboxId, options.mailboxId)
	].filter((condition) => condition !== undefined);
	return db
		.select()
		.from(activity)
		.where(and(...conditions))
		.orderBy(desc(activity.at))
		.limit(options.limit)
		.all()
		.map((row) => ({
			id: row.id,
			at: row.at.toISOString(),
			level: row.level,
			kind: row.kind,
			actor: row.actor,
			summary: row.summary,
			detail: row.detail,
			mailboxId: row.mailboxId
		}));
}

/** Deletes entries older than `keepDays`, so the log never grows without end. */
export function pruneActivity(db: Queryable, keepDays: number, now = Date.now()): number {
	const cutoff = new Date(now - keepDays * 24 * 60 * 60 * 1000);
	return db.delete(activity).where(lt(activity.at, cutoff)).run().changes;
}
