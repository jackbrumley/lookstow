import type { AppDatabase } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import { recordActivity } from '../activity/activity.ts';
import { GraphClient } from '../graph/client.ts';
import { sharedGovernor } from '../graph/governor.ts';
import type { DiscoveryProgress } from '../graph/discovery.ts';
import { TokenSource } from '../graph/token.ts';
import { allMailboxes, type MailboxRow } from '../mailboxes/repository.ts';
import {
	effectiveBackupRoot,
	graphCredentials,
	readDisk,
	readSchedule,
	readScope,
	savePause
} from '../settings/settings.ts';
import { diskStatus, measureDisk } from '../storage/disk.ts';
import { snapshotDue } from '../storage/index-snapshot.ts';
import type { RelayoutProgress } from '../storage/relayout.ts';
import { backupFolderProblem } from './backup-folder-check.ts';
import { BackupMover } from './backup-move-task.ts';
import { runDiscovery } from './discovery-pass.ts';
import { inScope } from './scope.ts';
import { planSyncs } from './scheduler.ts';
import { closeLastStop, moveToDateLayout, readOlderArchiveItems } from './startup-tasks.ts';
import { newestSnapshotAt, snapshotIndex } from './snapshot-task.ts';
import { syncOneMailbox } from './sync-pass.ts';
import { MailboxSlots, Throughput } from './throughput.ts';
import type { DiskStatus, EngineStatus } from '../../../domain/engine.ts';
import { failureKind, type FailureKind } from '../../../domain/failure-kind.ts';
import { failingMailboxes, lastFinished } from './run-history.ts';
import { formatPercent } from '../../../utils/format.ts';

/**
 * The backup engine: one per process. Every few seconds it measures the backup drive, starts
 * discovery when it is due or asked for, and fills free sync slots from the scheduler's queues
 * (scheduler.ts): each mailbox on its own timer, first copies never taking every slot.
 *
 * Pause stops everything: no new syncs start, and running ones stop after the page they are on
 * (each folder keeps its place, so Resume carries on from there). The disk guard pauses the
 * same way when the backup drive reaches its limit. Settings are read on every tick, so a
 * change takes effect within seconds.
 */
const TICK_MS = 5_000;
/** After a failed index snapshot, the next try. */
const SNAPSHOT_RETRY_MS = 60 * 60 * 1000;

export type EngineDeps = {
	/** The process's database itself (not a transaction): the daily snapshot copies it. */
	db: AppDatabase;
	dataDir: string;
	secretsKey: Buffer;
	now?: () => number;
};

type Live = {
	address: string;
	folder: string;
	stored: number;
	bytes: number;
	startedAt: number;
	firstCopy: boolean;
	done: Promise<void>;
};

export class Engine {
	readonly #deps: Required<EngineDeps>;
	#timer: NodeJS.Timeout | null = null;
	#stopping = false;
	#paused = false;
	readonly #running = new Map<string, Live>();
	readonly #requested = new Set<string>();
	#allRequestedAt: number | null = null;
	/** Mailboxes whose running sync must stop after its page (excluded, paused, deleted). */
	readonly #cancelled = new Set<string>();
	#discovery: Promise<void> | null = null;
	#discoveryRequested = false;
	#lastDiscoveryAt: number | null = null;
	#problem: string | null = null;
	/** What is missing from the setup; cleared as soon as the setup is complete. */
	#setupProblem: string | null = null;
	#waiting: EngineStatus['waiting'] = {
		requested: 0,
		due: 0,
		firstCopy: 0,
		later: 0,
		nextDueAt: null
	};
	#disk: DiskStatus | null = null;
	readonly #meter = new Throughput();
	readonly #slots: MailboxSlots;
	#currentSlots = MailboxSlots.START;
	/** Mailboxes whose latest syncs failed: how many in a row, and the latest failure's kind. */
	readonly #failing = new Map<string, { count: number; kind: FailureKind }>();
	#discoveryProgress: DiscoveryProgress | null = null;
	/** Moving files stored before 0.4.0 into the date layout; syncs wait until it is done. */
	#relayout: Promise<void> | null = null;
	#relayoutProgress: RelayoutProgress | null = null;
	/** Reading archive items stored before 0.6.0 for Search, once, in the background. */
	#indexing: Promise<void> | null = null;
	/** The daily copy of the index onto the backup drive, while it runs. */
	#snapshot: Promise<void> | null = null;
	#snapshotAt: number | null = null;
	#snapshotRetryAt: number | null = null;
	/** Why the backup folder may not be written now (a drive not attached), or null. */
	#backupProblem: string | null = null;
	/** Set while the backup folder moves: nothing that writes files starts. */
	#locked = false;
	readonly #mover: BackupMover;

	constructor(deps: EngineDeps) {
		this.#deps = { now: Date.now, ...deps };
		// Start with a few mailboxes and add more while the governor has room for them.
		this.#slots = new MailboxSlots(this.#deps.now());
		this.#mover = new BackupMover({
			db: this.#deps.db,
			dataDir: this.#deps.dataDir,
			now: this.#deps.now,
			whenIdle: () => this.#whenIdle(),
			stopping: () => this.#stopping,
			changed: () => {
				this.#tick();
			}
		});
	}

	/** Resolves once no sync, discovery, index copy or start-up move runs. */
	async #whenIdle(): Promise<void> {
		while (
			this.#running.size > 0 ||
			this.#discovery !== null ||
			this.#snapshot !== null ||
			this.#relayout !== null
		) {
			await Promise.all([
				...[...this.#running.values()].map((live) => live.done),
				this.#discovery,
				this.#snapshot,
				this.#relayout
			]);
		}
	}

	/** Moves the backup to `to` (a prepared, empty folder); throws with the reason it cannot. */
	async startMove(to: string, actor: string): Promise<void> {
		await this.#mover.start(to, actor);
		this.#tick();
	}

	cancelMove(actor: string): void {
		this.#mover.cancel(actor);
	}

	removeOldCopy(actor: string): void {
		this.#mover.removeOld(actor);
	}

	/** Why changes that touch the backup are refused now (it is moving), or null. */
	lockdown(): string | null {
		return this.#mover.lockdown();
	}

	start(): void {
		const { db, dataDir, now } = this.#deps;
		closeLastStop(db, now());
		this.#lastDiscoveryAt = lastFinished(db, 'discovery');
		for (const [id, failing] of failingMailboxes(db, now())) this.#failing.set(id, failing);
		const backupRoot = effectiveBackupRoot(db, dataDir);
		this.#snapshotAt = newestSnapshotAt(backupRoot);
		const stopping = () => this.#stopping;
		this.#relayout = moveToDateLayout(db, backupRoot, stopping, (progress) => {
			this.#relayoutProgress = { ...progress };
		}).finally(() => {
			this.#relayout = null;
			this.#relayoutProgress = null;
			this.#tick();
			// Reading older archive items for Search only reads files, so syncs go on meanwhile.
			this.#indexing = readOlderArchiveItems(db, backupRoot, stopping).finally(() => {
				this.#indexing = null;
			});
		});
		this.#timer = setInterval(() => {
			this.#tick();
		}, TICK_MS);
		this.#timer.unref();
		this.#mover.resume();
		this.#tick();
	}

	/** Lets every running sync finish its page, then stops. */
	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#timer !== null) {
			clearInterval(this.#timer);
		}
		await Promise.all([
			...[...this.#running.values()].map((live) => live.done),
			this.#discovery,
			this.#relayout,
			this.#indexing,
			this.#snapshot,
			this.#mover.stopped()
		]);
	}

	/** Pauses everything (Pause in the console, or the disk guard). */
	pause(reason: 'manual' | 'disk', actor: string, detail: string | null = null): void {
		const { db, now } = this.#deps;
		savePause(db, true, reason, now());
		this.#paused = true;
		recordActivity(db, {
			level: reason === 'disk' ? 'error' : 'info',
			kind: 'pause',
			actor,
			summary:
				reason === 'disk'
					? 'Backups paused: the backup drive is nearly full'
					: 'Backups paused. Running syncs stop after their current page.',
			detail
		});
	}

	/** Resumes, unless the backup drive is still over its limit. */
	resume(actor: string): void {
		const { db, now } = this.#deps;
		const disk = this.#measureDisk();
		if (disk.level === 'full') {
			throw new Error(
				`The backup drive is still ${formatPercent(disk.usedPercent)} full (the limit is ${disk.pausePercent}%). Free some space, or raise the limit in Settings, then resume.`
			);
		}
		savePause(db, false, 'manual', now());
		this.#paused = false;
		recordActivity(db, { level: 'info', kind: 'pause', actor, summary: 'Backups resumed' });
		this.#tick();
	}

	requestDiscovery(): void {
		this.#discoveryRequested = true;
		this.#tick();
	}

	/** Sync these mailboxes next (null: every mailbox in scope). */
	requestSync(mailboxIds: string[] | null): void {
		if (mailboxIds === null) {
			this.#allRequestedAt = this.#deps.now();
		} else {
			for (const id of mailboxIds) {
				this.#requested.add(id);
			}
		}
		this.#tick();
	}

	/** Stops this mailbox's running sync after its current page (it was excluded or paused). */
	cancel(mailboxId: string): void {
		if (this.#running.has(mailboxId)) {
			this.#cancelled.add(mailboxId);
		}
		this.#requested.delete(mailboxId);
	}

	/** Waits until this mailbox is not syncing (after cancel), up to `ms`. */
	async waitUntilIdle(mailboxId: string, ms = 60_000): Promise<boolean> {
		const live = this.#running.get(mailboxId);
		if (live === undefined) {
			return true;
		}
		const timeout = new Promise<false>((resolve) => {
			setTimeout(() => {
				resolve(false);
			}, ms).unref();
		});
		return Promise.race([live.done.then(() => true), timeout]);
	}

	isSyncing(mailboxId: string): boolean {
		return this.#running.has(mailboxId);
	}

	status(): EngineStatus {
		const { db } = this.#deps;
		const schedule = readSchedule(db);
		const discoverEveryMs = schedule.discoverEveryHours * 3_600_000;
		return {
			pause: schedule.paused
				? { paused: true, reason: schedule.pausedReason ?? 'manual', since: schedule.pausedAt }
				: { paused: false },
			problem: this.#backupProblem ?? this.#setupProblem ?? this.#problem,
			discovery: {
				running: this.#discovery !== null,
				progress: this.#discovery === null ? null : this.#discoveryProgress,
				lastAt: iso(this.#lastDiscoveryAt),
				nextAt:
					schedule.paused || this.#discovery !== null
						? null
						: iso((this.#lastDiscoveryAt ?? 0) + discoverEveryMs)
			},
			syncing: [...this.#running.entries()].map(([id, live]) => ({
				mailboxId: id,
				address: live.address,
				folder: live.folder,
				stored: live.stored,
				bytes: live.bytes,
				startedAt: new Date(live.startedAt).toISOString(),
				firstCopy: live.firstCopy
			})),
			waiting: this.#waiting,
			slots: {
				current: Math.min(this.#currentSlots, schedule.parallelMailboxes),
				maximum: schedule.parallelMailboxes
			},
			failing: this.#failingCounts(),
			rates: {
				lastMinute: this.#meter.rates(this.#deps.now(), 60_000),
				last15Minutes: this.#meter.rates(this.#deps.now(), 15 * 60_000)
			},
			throttled: {
				lastMinute: this.#meter.rates(this.#deps.now(), 60_000).throttled,
				last15Minutes: this.#meter.rates(this.#deps.now(), 15 * 60_000).throttled
			},
			disk: this.#disk ?? this.#measureDisk(),
			relayout: this.#relayout === null ? null : this.#relayoutProgress,
			indexSnapshot: { running: this.#snapshot !== null, lastAt: iso(this.#snapshotAt) },
			backupMove: this.#mover.status()
		};
	}

	#failingCounts(): EngineStatus['failing'] {
		const counts: EngineStatus['failing'] = {};
		for (const { kind } of this.#failing.values()) counts[kind] = (counts[kind] ?? 0) + 1;
		return counts;
	}

	#measureDisk(): DiskStatus {
		const { db, dataDir } = this.#deps;
		const root = effectiveBackupRoot(db, dataDir);
		let measured: ReturnType<typeof measureDisk>;
		try {
			measured = measureDisk(root);
		} catch (error) {
			serverLog('warn', 'disk', `Could not measure ${root}: ${errorText(error)}`);
			measured = null;
		}
		this.#disk = diskStatus(root, measured, readDisk(db));
		return this.#disk;
	}

	#tick(): void {
		if (this.#stopping) {
			return;
		}
		try {
			this.#plan();
		} catch (error) {
			// A settings value that no longer validates, or a database error: say so, try again.
			this.#problem = errorText(error);
			serverLog('error', 'engine', `Engine tick failed: ${this.#problem}`);
		}
	}

	#plan(): void {
		const { db, now, dataDir } = this.#deps;
		const schedule = readSchedule(db);
		this.#paused = schedule.paused;
		const disk = this.#measureDisk();
		if (disk.level === 'full' && !this.#paused) {
			this.pause(
				'disk',
				'system',
				`${disk.path} is ${formatPercent(disk.usedPercent)} full; the limit is ${disk.pausePercent}%.`
			);
		}
		// Lockdown: the backup folder is moving, so nothing that writes there starts.
		this.#locked = this.#mover.lockdown() !== null;
		if (this.#locked) {
			return;
		}
		// The backup folder must be the one the index knows before anything is written to it.
		this.#backupProblem = backupFolderProblem(db, effectiveBackupRoot(db, dataDir));
		if (this.#backupProblem !== null) {
			return;
		}
		this.#snapshotWhenDue(disk);
		if (this.#paused) {
			return;
		}
		const client = this.#client();
		if (client === null) {
			return;
		}
		const time = now();
		const discoveryDue =
			this.#lastDiscoveryAt === null ||
			time - this.#lastDiscoveryAt >= schedule.discoverEveryHours * 3_600_000;
		if (this.#discovery === null && (this.#discoveryRequested || discoveryDue)) {
			this.#discoveryRequested = false;
			this.#discovery = this.#discover(client).finally(() => {
				this.#discovery = null;
			});
		}

		if (this.#relayout !== null) {
			// Files are moving to the date layout: a sync now would race the move.
			return;
		}
		this.#currentSlots = this.#slots.adjust({
			maximum: schedule.parallelMailboxes,
			headroom: sharedGovernor().headroom().more,
			running: this.#running.size,
			waiting: this.#waiting.requested + this.#waiting.due + this.#waiting.firstCopy,
			now: time
		});
		const scope = readScope(db);
		const eligible = allMailboxes(db).filter(
			(row) => row.goneAt === null && !row.paused && inScope(row, scope)
		);
		const plan = planSyncs({
			candidates: eligible.map((row) => ({
				id: row.id,
				firstCopyDone: row.firstCopyDone,
				lastSyncStartedAt: row.lastSyncStartedAt?.getTime() ?? null,
				lastSyncFinishedAt: row.lastSyncFinishedAt?.getTime() ?? null,
				failuresInARow: this.#failing.get(row.id)?.count ?? 0
			})),
			running: new Set(this.#running.keys()),
			requested: this.#requested,
			allRequestedAt: this.#allRequestedAt,
			now: time,
			intervalMs: schedule.syncEveryMinutes * 60_000,
			slots: this.#currentSlots
		});
		this.#waiting = { ...plan.waiting, nextDueAt: iso(plan.waiting.nextDueAt) };
		const byId = new Map(eligible.map((row) => [row.id, row]));
		const backupRoot = effectiveBackupRoot(db, dataDir);
		for (const id of plan.start) {
			const row = byId.get(id);
			if (row !== undefined) {
				this.#requested.delete(id);
				this.#startSync(client, row, backupRoot);
			}
		}
		if (plan.waiting.requested === 0 && this.#allRequestedAt !== null && plan.start.length === 0) {
			this.#allRequestedAt = null;
		}
	}

	/**
	 * The daily index snapshot: after the start-up passes, never onto a full drive, and an hour
	 * after a failure. It runs while paused too: the index needs its copy either way.
	 */
	#snapshotWhenDue(disk: DiskStatus): void {
		const { db, dataDir, now } = this.#deps;
		const time = now();
		if (
			this.#snapshot !== null ||
			this.#relayout !== null ||
			this.#indexing !== null ||
			disk.level === 'full' ||
			(this.#snapshotRetryAt !== null && time < this.#snapshotRetryAt) ||
			!snapshotDue(this.#snapshotAt, time)
		) {
			return;
		}
		this.#snapshot = snapshotIndex(db, effectiveBackupRoot(db, dataDir), time)
			.then((takenAt) => {
				if (takenAt === null) {
					this.#snapshotRetryAt = now() + SNAPSHOT_RETRY_MS;
				} else {
					this.#snapshotAt = takenAt;
					this.#snapshotRetryAt = null;
				}
			})
			.finally(() => {
				this.#snapshot = null;
			});
	}

	#client(): GraphClient | null {
		const found = graphCredentials(this.#deps.db, this.#deps.secretsKey);
		if ('missing' in found) {
			this.#setupProblem = found.missing;
			return null;
		}
		this.#setupProblem = null;
		return new GraphClient(new TokenSource(found.credentials), {
			governor: sharedGovernor(),
			onThrottle: (status, waitMs) => {
				this.#meter.record(this.#deps.now(), { throttled: 1 });
				serverLog(
					'warn',
					'graph',
					`Microsoft Graph asked Lookstow to slow down (${status}); waiting ${Math.round(waitMs / 1000)} s`
				);
			}
		});
	}

	async #discover(client: GraphClient): Promise<void> {
		const { db, now } = this.#deps;
		try {
			const result = await runDiscovery(db, client, now, (progress) => {
				this.#discoveryProgress = progress;
			});
			if (result.kind === 'failed') {
				this.#problem = result.problem;
				return;
			}
			this.#problem = null;
			// Mailboxes found or back again start their first copy straight away (if in scope).
			for (const id of result.syncNext) {
				this.#requested.add(id);
			}
		} finally {
			this.#lastDiscoveryAt = now();
		}
	}

	#startSync(client: GraphClient, mailbox: MailboxRow, backupRoot: string): void {
		const { db, now } = this.#deps;
		const live: Live = {
			address: mailbox.address,
			folder: '',
			stored: 0,
			bytes: 0,
			startedAt: now(),
			firstCopy: !mailbox.firstCopyDone,
			done: Promise.resolve()
		};
		this.#running.set(mailbox.id, live);
		live.done = syncOneMailbox(
			{
				db,
				client,
				backupRoot,
				now,
				stopping: () =>
					this.#stopping ||
					this.#paused ||
					this.#locked ||
					this.#backupProblem !== null ||
					this.#cancelled.has(mailbox.id) ||
					this.#disk?.level === 'full',
				progress: (update) => {
					this.#meter.record(now(), {
						bytes: update.bytes - live.bytes,
						messages: update.stored - live.stored
					});
					Object.assign(live, update);
				}
			},
			mailbox
		)
			.then((result) => {
				if (result.failed === null) {
					this.#failing.delete(mailbox.id);
				} else {
					this.#failing.set(mailbox.id, {
						count: (this.#failing.get(mailbox.id)?.count ?? 0) + 1,
						kind: failureKind(result.failed)
					});
				}
				// Stopped by Pause, the disk guard or a cancel, not finished: it carries on as soon as
				// it may (Resume), instead of waiting a whole interval like a mailbox that was done.
				if (result.stoppedEarly && !this.#stopping) {
					this.#requested.add(mailbox.id);
				}
			})
			.catch((error: unknown) => {
				serverLog('error', 'engine', `Unexpected sync error: ${errorText(error)}`);
			})
			.finally(() => {
				this.#running.delete(mailbox.id);
				this.#cancelled.delete(mailbox.id);
				// A slot is free: fill it now rather than on the next tick.
				this.#tick();
			});
	}
}

function iso(time: number | null): string | null {
	return time === null ? null : new Date(time).toISOString();
}
