import type { Queryable } from '../../database/connection.ts';
import { errorText } from '../../log.ts';
import { recordActivity } from '../activity/activity.ts';
import type { GraphClient } from '../graph/client.ts';
import { discoverMailboxes, type DiscoveryProgress } from '../graph/discovery.ts';
import { applyDiscovery, finishRun, startRun } from '../mailboxes/repository.ts';
import { readScope } from '../settings/settings.ts';

/**
 * What one discovery run left for the engine. `syncNext`: mailboxes found, or back again, that
 * start their first copy straight away.
 */
export type DiscoveryResult =
	{ kind: 'done'; syncNext: string[] } | { kind: 'failed'; problem: string };

/**
 * One discovery run: every user with a mail address and their archives, applied to the index
 * (added, refreshed, marked gone; never deleted), recorded as a run and in the activity log.
 */
export async function runDiscovery(
	db: Queryable,
	client: GraphClient,
	now: () => number,
	progress: (progress: DiscoveryProgress) => void
): Promise<DiscoveryResult> {
	const runId = startRun(db, 'discovery', null, now());
	try {
		const scope = readScope(db);
		progress({ usersTotal: null, usersChecked: 0, found: 0 });
		const result = await discoverMailboxes(client, {
			includeArchives: scope.includeArchives,
			progress
		});
		const changes = applyDiscovery(db, result.mailboxes, now());
		finishRun(
			db,
			runId,
			{
				outcome: 'ok',
				added: changes.added.length,
				removed: changes.gone.length,
				byteCount: 0,
				error: null
			},
			now()
		);
		recordActivity(db, {
			level: result.warnings.length > 0 ? 'warn' : 'info',
			kind: 'discovery',
			actor: 'system',
			summary: `Discovery found ${result.mailboxes.length} mailboxes in ${result.usersChecked} users: ${changes.added.length} new, ${changes.gone.length} gone`,
			detail: result.warnings.length > 0 ? result.warnings.slice(0, 20).join('; ') : null
		});
		for (const row of changes.added) {
			recordActivity(db, {
				level: 'info',
				kind: 'mailbox-found',
				actor: 'system',
				summary: `New mailbox: ${row.address} (${row.kind})`,
				mailboxId: row.id
			});
		}
		for (const row of changes.gone) {
			recordActivity(db, {
				level: 'warn',
				kind: 'mailbox-gone',
				actor: 'system',
				summary: `${row.address} (${row.kind}) is no longer in Microsoft 365. Its backup is kept.`,
				mailboxId: row.id
			});
		}
		return { kind: 'done', syncNext: [...changes.added, ...changes.returned].map((row) => row.id) };
	} catch (error) {
		const message = errorText(error);
		finishRun(
			db,
			runId,
			{ outcome: 'failed', added: 0, removed: 0, byteCount: 0, error: message },
			now()
		);
		recordActivity(db, {
			level: 'error',
			kind: 'discovery',
			actor: 'system',
			summary: 'Discovery failed',
			detail: message
		});
		return { kind: 'failed', problem: `Discovery failed: ${message}` };
	}
}
