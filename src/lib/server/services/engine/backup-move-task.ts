import { resolve } from 'node:path';
import type { Queryable } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import { recordActivity } from '../activity/activity.ts';
import { storedFileHashes, storedTotals } from '../mailboxes/repository.ts';
import {
	effectiveBackupRoot,
	readBackupMarker,
	readBackupMove,
	saveBackup,
	saveBackupMove
} from '../settings/settings.ts';
import {
	copyBackup,
	missingUnder,
	moveTargetProblem,
	removeOldCopy
} from '../storage/backup-move.ts';
import type { BackupMoveStatus } from '../../../domain/engine.ts';
import { formatBytes, plural } from '../../../utils/format.ts';

/** Room asked for beyond what the index holds: the index copies, and some to spare. */
const SPARE_BYTES = 2 * 1024 ** 3;

type MoverDeps = {
	db: Queryable;
	dataDir: string;
	now: () => number;
	/** Resolves once no sync or discovery runs (the engine starts none while the move runs). */
	whenIdle: () => Promise<void>;
	/** The service is stopping: the move stops after its current file and carries on next start. */
	stopping: () => boolean;
	/** Called when a move or removal ends, so the engine plans again at once. */
	changed: () => void;
};

/**
 * The backup folder's move and the removal of its old copy (docs/specs/SPEC-BACKUP-FOLDER-MOVE.md).
 * The saved state (settings `backupMove`) says what is under way; this class runs it and keeps
 * the live progress. While a move runs the backup is in lockdown: no sync, discovery, index copy,
 * update or change to what is backed up starts, and actions that would change files are refused.
 */
export class BackupMover {
	readonly #deps: MoverDeps;
	#work: Promise<void> | null = null;
	#cancelled = false;
	#phase: 'waiting' | 'copying' | 'checking' = 'waiting';
	#files = 0;
	#bytes = 0;
	#totals = { files: 0, bytes: 0 };
	#removing: number | null = null;

	constructor(deps: MoverDeps) {
		this.#deps = deps;
	}

	/** Why changes are refused now (a move is under way), or null. */
	lockdown(): string | null {
		const state = readBackupMove(this.#deps.db);
		return state.kind === 'moving'
			? `The backup is moving to ${state.to}. Backups and changes wait until the move ends.`
			: null;
	}

	/** Carries on a move the last run of the service did not finish. */
	resume(): void {
		if (readBackupMove(this.#deps.db).kind === 'moving') this.#runMove();
	}

	/** Checks the new folder and starts the move; throws with the reason it cannot start. */
	async start(to: string, actor: string): Promise<void> {
		const { db, dataDir, now } = this.#deps;
		if (readBackupMove(db).kind !== 'none') {
			throw new Error(
				'A move is already under way, or the old copy of the last one is still kept.'
			);
		}
		const from = effectiveBackupRoot(db, dataDir);
		const marker = readBackupMarker(db);
		const totals = storedTotals(db);
		const problem = await moveTargetProblem(
			from,
			resolve(to),
			marker?.id ?? 'none',
			totals.bytes + SPARE_BYTES
		);
		if (problem !== null) throw new Error(problem);
		saveBackupMove(db, {
			kind: 'moving',
			from,
			to: resolve(to),
			startedAt: new Date(now()).toISOString(),
			actor
		});
		recordActivity(db, {
			level: 'info',
			kind: 'backup-move',
			actor,
			summary: `Moving the backup from ${from} to ${resolve(to)}`,
			detail: `${plural(totals.files, 'file')} (${formatBytes(totals.bytes)}) to copy. Backups stop until the copy is checked; the old copy is kept until you remove it.`
		});
		this.#runMove();
	}

	/** Stops a move: the backup stays where it was; what was copied so far stays in the new folder. */
	cancel(actor: string): void {
		const { db } = this.#deps;
		const state = readBackupMove(db);
		if (state.kind !== 'moving') throw new Error('No move is under way.');
		this.#cancelled = true;
		saveBackupMove(db, { kind: 'none' });
		recordActivity(db, {
			level: 'info',
			kind: 'backup-move',
			actor,
			summary: `The move to ${state.to} was stopped; the backup stays in ${state.from}`,
			detail: `The files copied so far stay in ${state.to}. A later move to the same folder carries on from them.`
		});
		this.#deps.changed();
	}

	/** Removes the old copy after a move (the typed confirmation is checked by the caller). */
	removeOld(actor: string): void {
		const { db } = this.#deps;
		const state = readBackupMove(db);
		if (state.kind !== 'moved') throw new Error('There is no old copy to remove.');
		if (this.#work !== null) throw new Error('The old copy is already being removed.');
		recordActivity(db, {
			level: 'info',
			kind: 'backup-move',
			actor,
			summary: `Removing the old copy of the backup in ${state.from}`,
			detail: `Each file is deleted only when its copy in ${state.to} has the same contents.`
		});
		this.#removing = 0;
		this.#work = this.#remove(state.from, state.to, actor).finally(() => {
			this.#work = null;
			this.#removing = null;
			this.#deps.changed();
		});
	}

	status(): BackupMoveStatus {
		const state = readBackupMove(this.#deps.db);
		switch (state.kind) {
			case 'none':
				return { kind: 'none' };
			case 'moving':
				return {
					kind: 'moving',
					from: state.from,
					to: state.to,
					phase: this.#phase,
					files: this.#files,
					bytes: this.#bytes,
					totalFiles: this.#totals.files,
					totalBytes: this.#totals.bytes
				};
			case 'moved':
				return { ...state, removing: this.#removing };
		}
	}

	/** Resolves when nothing is running (for the service's stop). */
	async stopped(): Promise<void> {
		await this.#work;
	}

	#runMove(): void {
		if (this.#work !== null) return;
		this.#cancelled = false;
		this.#work = this.#move()
			.catch((error: unknown) => {
				const { db } = this.#deps;
				saveBackupMove(db, { kind: 'none' });
				recordActivity(db, {
					level: 'error',
					kind: 'backup-move',
					actor: 'system',
					summary: 'Moving the backup failed; it stays where it was',
					detail: errorText(error)
				});
				serverLog('error', 'backup-move', `Move failed: ${errorText(error)}`);
			})
			.finally(() => {
				this.#work = null;
				this.#deps.changed();
			});
	}

	async #move(): Promise<void> {
		const { db, now, whenIdle, stopping } = this.#deps;
		const state = readBackupMove(db);
		if (state.kind !== 'moving') return;
		this.#phase = 'waiting';
		this.#files = 0;
		this.#bytes = 0;
		this.#totals = storedTotals(db);
		await whenIdle();
		this.#phase = 'copying';
		const hashes = storedFileHashes(db);
		const copied = await copyBackup({
			from: state.from,
			to: state.to,
			indexed: (path) => hashes.get(path),
			stopping: () => stopping() || this.#cancelled,
			progress: (progress) => {
				this.#files = progress.files;
				this.#bytes = progress.bytes;
			}
		});
		// Stopped (the service is stopping, or Stop the move): nothing switches.
		if (copied.stopped || readBackupMove(db).kind !== 'moving') return;
		this.#phase = 'checking';
		const missing = missingUnder(state.to, hashes.keys());
		const problems = [
			...copied.problems,
			...missing.slice(0, 50).map((path) => `${path}: not in the old folder either`)
		];
		// The switch: from here the backup is in the new folder.
		saveBackup(db, { root: state.to });
		saveBackupMove(db, {
			kind: 'moved',
			from: state.from,
			to: state.to,
			finishedAt: new Date(now()).toISOString(),
			files: copied.files,
			bytes: copied.bytes,
			problems: problems.length
		});
		recordActivity(db, {
			level: problems.length > 0 ? 'warn' : 'info',
			kind: 'backup-move',
			actor: 'system',
			summary: `The backup moved to ${state.to}: ${plural(copied.files, 'file')} (${formatBytes(copied.bytes)}) copied and checked`,
			detail: [
				`Backups carry on in ${state.to}. The old copy in ${state.from} is kept until you remove it in Settings > Backup folder.`,
				problems.length > 0
					? `These files could not be checked against the index:\n${problems.join('\n')}`
					: ''
			]
				.filter((part) => part !== '')
				.join('\n\n')
		});
	}

	async #remove(from: string, to: string, actor: string): Promise<void> {
		const { db, stopping } = this.#deps;
		try {
			const result = await removeOldCopy({
				from,
				to,
				stopping,
				progress: (removed) => {
					this.#removing = removed;
				}
			});
			if (result.stopped) return;
			if (result.kept.length === 0) {
				saveBackupMove(db, { kind: 'none' });
			}
			recordActivity(db, {
				level: result.kept.length > 0 ? 'warn' : 'info',
				kind: 'backup-move',
				actor,
				summary:
					result.kept.length === 0
						? `The old copy of the backup in ${from} was removed (${plural(result.removed, 'file')})`
						: `${plural(result.removed, 'file')} of the old copy in ${from} were removed; ${plural(result.kept.length, 'file')} kept`,
				detail:
					result.kept.length === 0
						? null
						: `These files are kept because their copy in ${to} is missing or different:\n${result.kept.slice(0, 50).join('\n')}`
			});
		} catch (error) {
			recordActivity(db, {
				level: 'error',
				kind: 'backup-move',
				actor: 'system',
				summary: `Removing the old copy in ${from} stopped`,
				detail: errorText(error)
			});
		}
	}
}
