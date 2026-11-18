import { desc, eq } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { runs } from '../../database/schema.ts';
import { errorText, serverLog } from '../../log.ts';
import { recordActivity } from '../activity/activity.ts';
import { GraphClient } from '../graph/client.ts';
import { discoverMailboxes, forEachLimited } from '../graph/discovery.ts';
import { TokenSource } from '../graph/token.ts';
import {
	allMailboxes,
	applyDiscovery,
	closeInterruptedRuns,
	finishRun,
	mailboxById,
	markSyncFinished,
	markSyncStarted,
	startRun,
	type MailboxRow
} from '../mailboxes/repository.ts';
import {
	effectiveBackupRoot,
	graphCredentials,
	readSchedule,
	readScope
} from '../settings/settings.ts';
import { inScope } from './scope.ts';
import { syncMailbox } from './mailbox-sync.ts';
import type { EngineStatus } from '../../../domain/engine.ts';

/**
 * The backup engine: one per process. A timer checks every 30 seconds whether discovery or a
 * sync pass is due; Discover now and Sync now queue the same work for the next tick. One piece
 * of work runs at a time (a pass syncs several mailboxes in parallel inside it), so discovery
 * never changes the mailbox list under a running pass.
 */
const TICK_MS = 30_000;

export type EngineDeps = {
	db: Queryable;
	dataDir: string;
	secretsKey: Buffer;
	now?: () => number;
	/** Swapped in tests. */
	createClient?: (credentials: Parameters<typeof graphCredentials>[1]) => GraphClient | null;
};

type Job = { kind: 'discovery' } | { kind: 'sync'; mailboxIds: string[] | null; reason: string };

export class Engine {
	readonly #deps: Required<Omit<EngineDeps, 'createClient'>>;
	#timer: NodeJS.Timeout | null = null;
	#stopping = false;
	#busy: Promise<void> | null = null;
	readonly #queue: Job[] = [];
	readonly #live = new Map<
		string,
		{ address: string; folder: string; stored: number; bytes: number; startedAt: number }
	>();
	#phase: EngineStatus['phase'] = 'idle';
	#problem: string | null = null;
	/** What is missing from the setup; cleared as soon as the setup is complete. */
	#setupProblem: string | null = null;
	/** When the running sync of every mailbox started, or null. */
	#passStartedAt: number | null = null;
	#lastDiscoveryAt: number | null = null;
	#lastPassAt: number | null = null;

	constructor(deps: EngineDeps) {
		this.#deps = { now: Date.now, ...deps };
	}

	start(): void {
		const { db, now } = this.#deps;
		const interrupted = closeInterruptedRuns(db, now());
		if (interrupted > 0) {
			recordActivity(db, {
				level: 'warn',
				kind: 'engine',
				actor: 'system',
				summary: `${interrupted} run${interrupted === 1 ? ' was' : 's were'} interrupted by the last stop`
			});
		}
		this.#lastDiscoveryAt = lastFinished(db, 'discovery');
		this.#lastPassAt = lastFinished(db, 'sync');
		this.#timer = setInterval(() => {
			this.#tick();
		}, TICK_MS);
		this.#timer.unref();
		this.#tick();
	}

	/** Finishes the current page of work and stops. */
	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#timer !== null) {
			clearInterval(this.#timer);
		}
		await this.#busy;
	}

	requestDiscovery(): void {
		if (!this.#queue.some((job) => job.kind === 'discovery')) {
			this.#queue.push({ kind: 'discovery' });
		}
		this.#tick();
	}

	requestSync(mailboxIds: string[] | null, reason: string): void {
		this.#queue.push({ kind: 'sync', mailboxIds, reason });
		this.#tick();
	}

	status(): EngineStatus {
		const schedule = readSchedule(this.#deps.db);
		const discoverEveryMs = schedule.discoverEveryHours * 3_600_000;
		const syncEveryMs = schedule.syncEveryMinutes * 60_000;
		return {
			phase: this.#phase,
			paused: schedule.paused,
			problem: this.#setupProblem ?? this.#problem,
			lastDiscoveryAt: iso(this.#lastDiscoveryAt),
			nextDiscoveryAt: schedule.paused ? null : iso((this.#lastDiscoveryAt ?? 0) + discoverEveryMs),
			lastPassAt: iso(this.#lastPassAt),
			passStartedAt: iso(this.#passStartedAt),
			nextPassAt:
				schedule.paused || this.#passStartedAt !== null
					? null
					: iso((this.#lastPassAt ?? 0) + syncEveryMs),
			queued: this.#queue.length,
			syncing: [...this.#live.entries()].map(([id, live]) => ({
				mailboxId: id,
				address: live.address,
				folder: live.folder,
				stored: live.stored,
				bytes: live.bytes,
				startedAt: new Date(live.startedAt).toISOString()
			}))
		};
	}

	#tick(): void {
		if (this.#busy !== null || this.#stopping) {
			return;
		}
		const job = this.#queue.shift() ?? this.#dueJob();
		if (job === null) {
			return;
		}
		this.#busy = this.#run(job)
			.catch((error: unknown) => {
				serverLog('error', 'engine', `Unexpected engine error: ${errorText(error)}`);
			})
			.finally(() => {
				this.#busy = null;
				this.#phase = 'idle';
				// Work queued while busy starts at once rather than on the next tick.
				if (this.#queue.length > 0) {
					this.#tick();
				}
			});
	}

	#dueJob(): Job | null {
		const { db, now } = this.#deps;
		let schedule;
		try {
			schedule = readSchedule(db);
		} catch (error) {
			this.#problem = errorText(error);
			return null;
		}
		if (schedule.paused) {
			return null;
		}
		const time = now();
		if (
			this.#lastDiscoveryAt === null ||
			time - this.#lastDiscoveryAt >= schedule.discoverEveryHours * 3_600_000
		) {
			return { kind: 'discovery' };
		}
		if (
			this.#lastPassAt === null ||
			time - this.#lastPassAt >= schedule.syncEveryMinutes * 60_000
		) {
			return { kind: 'sync', mailboxIds: null, reason: 'scheduled' };
		}
		return null;
	}

	#client(): GraphClient | null {
		const found = graphCredentials(this.#deps.db, this.#deps.secretsKey);
		if ('missing' in found) {
			this.#setupProblem = found.missing;
			return null;
		}
		this.#setupProblem = null;
		return new GraphClient(new TokenSource(found.credentials));
	}

	async #run(job: Job): Promise<void> {
		const client = this.#client();
		if (client === null) {
			// Not set up yet. Nothing is marked as done, so the first discovery runs on the first
			// tick after the connection is complete, not a whole discovery interval later. Each tick
			// only reads the settings until then.
			return;
		}
		if (job.kind === 'discovery') {
			await this.#discover(client);
		} else {
			await this.#pass(client, job);
		}
	}

	async #discover(client: GraphClient): Promise<void> {
		const { db, now } = this.#deps;
		this.#phase = 'discovering';
		const runId = startRun(db, 'discovery', null, now());
		try {
			const scope = readScope(db);
			const result = await discoverMailboxes(client, { includeArchives: scope.includeArchives });
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
			this.#problem = null;
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
			// New mailboxes start their first copy straight away.
			if (changes.added.length > 0 || changes.returned.length > 0) {
				this.#queue.push({
					kind: 'sync',
					mailboxIds: [...changes.added, ...changes.returned].map((row) => row.id),
					reason: 'new mailboxes'
				});
			}
		} catch (error) {
			const message = errorText(error);
			this.#problem = `Discovery failed: ${message}`;
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
		} finally {
			this.#lastDiscoveryAt = now();
		}
	}

	async #pass(client: GraphClient, job: Extract<Job, { kind: 'sync' }>): Promise<void> {
		const { db, now, dataDir } = this.#deps;
		this.#phase = 'syncing';
		const scope = readScope(db);
		const schedule = readSchedule(db);
		const backupRoot = effectiveBackupRoot(db, dataDir);
		const targets = (
			job.mailboxIds === null ? allMailboxes(db) : job.mailboxIds.map((id) => mailboxById(db, id))
		)
			.filter((row): row is MailboxRow => row !== undefined)
			.filter((row) => row.goneAt === null && row.kind !== 'archive' && inScope(row, scope));
		let failed = 0;
		if (job.mailboxIds === null) {
			this.#passStartedAt = now();
		}
		await forEachLimited(targets, schedule.parallelMailboxes, async (mailbox) => {
			if (this.#stopping) {
				return;
			}
			const ok = await this.#syncOne(client, mailbox, backupRoot);
			if (!ok) {
				failed += 1;
			}
		});
		if (job.mailboxIds === null) {
			this.#lastPassAt = now();
			this.#passStartedAt = null;
		}
		this.#problem =
			failed > 0 ? `${failed} mailbox${failed === 1 ? '' : 'es'} failed in the last pass` : null;
	}

	async #syncOne(client: GraphClient, mailbox: MailboxRow, backupRoot: string): Promise<boolean> {
		const { db, now } = this.#deps;
		const runId = startRun(db, 'sync', mailbox.id, now());
		markSyncStarted(db, mailbox.id, now());
		this.#live.set(mailbox.id, {
			address: mailbox.address,
			folder: '',
			stored: 0,
			bytes: 0,
			startedAt: now()
		});
		try {
			const outcome = await syncMailbox(
				{
					db,
					client,
					backupRoot,
					now,
					stopping: () => this.#stopping,
					progress: (update) => {
						const live = this.#live.get(mailbox.id);
						if (live !== undefined) {
							this.#live.set(mailbox.id, { ...live, ...update });
						}
					}
				},
				mailbox
			);
			markSyncFinished(db, mailbox.id, now(), {
				error: null,
				firstCopyDone: outcome.firstCopyDone || mailbox.firstCopyDone
			});
			finishRun(
				db,
				runId,
				{
					outcome: 'ok',
					added: outcome.added,
					removed: outcome.removed,
					byteCount: outcome.byteCount,
					error: null
				},
				now()
			);
			if (!mailbox.firstCopyDone && outcome.firstCopyDone) {
				recordActivity(db, {
					level: 'info',
					kind: 'first-copy',
					actor: 'system',
					summary: `First full copy of ${mailbox.address} finished`,
					mailboxId: mailbox.id
				});
			}
			if (mailbox.lastSyncError !== null) {
				recordActivity(db, {
					level: 'info',
					kind: 'sync',
					actor: 'system',
					summary: `${mailbox.address} syncs again`,
					mailboxId: mailbox.id
				});
			}
			return true;
		} catch (error) {
			const message = errorText(error);
			markSyncFinished(db, mailbox.id, now(), {
				error: message,
				firstCopyDone: mailbox.firstCopyDone
			});
			finishRun(
				db,
				runId,
				{ outcome: 'failed', added: 0, removed: 0, byteCount: 0, error: message },
				now()
			);
			// One entry when a mailbox starts failing, not one every pass.
			if (mailbox.lastSyncError !== message) {
				recordActivity(db, {
					level: 'error',
					kind: 'sync',
					actor: 'system',
					summary: `Sync of ${mailbox.address} failed`,
					detail: message,
					mailboxId: mailbox.id
				});
			}
			return false;
		} finally {
			this.#live.delete(mailbox.id);
		}
	}

	isSyncing(mailboxId: string): boolean {
		return this.#live.has(mailboxId);
	}
}

function lastFinished(db: Queryable, kind: 'discovery' | 'sync'): number | null {
	const row = db
		.select({ finishedAt: runs.finishedAt })
		.from(runs)
		.where(eq(runs.kind, kind))
		.orderBy(desc(runs.finishedAt))
		.limit(1)
		.get();
	return row?.finishedAt?.getTime() ?? null;
}

function iso(time: number | null): string | null {
	return time === null ? null : new Date(time).toISOString();
}
