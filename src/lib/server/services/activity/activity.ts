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

/** Told about every entry once it is recorded (email alerts listen here). */
export type ActivityListener = (db: Queryable, entry: NewActivity, now: number) => void;

const listeners = new Set<ActivityListener>();

/** Adds a listener; returns the function that removes it. */
export function onActivity(listener: ActivityListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

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
	for (const listener of listeners) {
		// A listener's failure never stops what recorded the entry.
		try {
			listener(db, entry, now);
		} catch (error) {
			serverLog(
				'error',
				'activity',
				`A listener failed on "${entry.summary}": ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
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
