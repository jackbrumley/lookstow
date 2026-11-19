import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions } from '#lib/domain/releases/version.ts';
import { APP_VERSION } from '#lib/utils/app-version.ts';
import {
	updateCacheSchema,
	updaterStatusSchema,
	updaterTimingsSchema,
	type ReleaseTarget,
	type ServerUpdateOperation,
	type ServerUpdateView,
	type UpdateCache
} from '#lib/schemas/releases/server-updates.ts';
import type { LauncherConfig } from '../../env.ts';
import { errorText, serverLog } from '../../log.ts';
import { isMissing, readBounded } from './files.ts';
import { download, newestRelease, RELEASE_PUBLIC_KEY, type OfferedRelease } from './release.ts';

const DAY = 24 * 60 * 60 * 1000;
const FAILED_CHECK_RETRY = 5 * 60 * 1000;
/**
 * The request for the launcher's updater, which runs as root or SYSTEM. It is always empty: the
 * updater never reads it, and installs only the newest release signed with the key compiled
 * into it. Writing it is all the app can do.
 */
export const UPDATE_FLAG = 'update-requested';
/** Written only by the updater. */
export const UPDATE_STATUS = 'update-status.json';
/** Written only by the updater: when each step of the last update ended. */
export const UPDATE_TIMINGS = 'update-timings.json';
/** The Windows scheduled task that runs the updater as SYSTEM (the launcher registers it). */
const WINDOWS_UPDATE_TASK = 'Lookstow Update';
/** The last release check, kept across restarts. */
export const CHECK_CACHE = 'check.json';
const EMPTY: UpdateCache = {
	checkedAtIso: null,
	lastSuccessAtIso: null,
	release: null,
	problem: null
};
const IDLE: ServerUpdateOperation = {
	phase: 'idle',
	from: null,
	to: null,
	message: '',
	atIso: null
};
const IN_PROGRESS = new Set<ServerUpdateOperation['phase']>([
	'requested',
	'checking',
	'downloading',
	'switching',
	'starting'
]);
export const REINSTALL_ONCE =
	'This release cannot update this computer by itself. Run the installer again (install.sh on Linux, install.ps1 on Windows); it keeps your data.';
export const SOURCE_RUN =
	'This is a source run (npm run dev or npm start). Install a release to update Lookstow from the console.';

/** Who asked for a release check: the daily timer, or someone in the console (recorded). */
export type CheckSource = 'schedule' | 'console';

/**
 * One line for the Activity page: a release check asked for in the console, or Update now.
 * live.ts hands it to the activity log (services/activity/activity.ts).
 */
export type ActivityEntry = {
	level: 'info' | 'warn';
	kind: 'update-checked' | 'update-requested';
	actor: 'console' | 'system';
	summary: string;
	detail: string | null;
};

type Latest = () => Promise<OfferedRelease | null>;
type RecordActivity = (entry: ActivityEntry) => void;

export class ServerUpdates {
	readonly #config: LauncherConfig;
	readonly #current: string;
	readonly #latest: Latest;
	readonly #record: RecordActivity;
	#cache: UpdateCache;
	#pending: Promise<void> | undefined;

	constructor(config: LauncherConfig, current: string, latest: Latest, record: RecordActivity) {
		this.#config = config;
		this.#current = current;
		this.#latest = latest;
		this.#record = record;
		this.#cache = { ...EMPTY };
		if (config.kind === 'installed') {
			try {
				this.#cache = updateCacheSchema.parse(
					JSON.parse(readBounded(join(config.dataDir, CHECK_CACHE), 512 * 1024).toString('utf8'))
				);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
	}

	/** The request waiting for the updater, else the updater's last status. */
	#operation(): ServerUpdateOperation {
		const config = this.#config;
		if (config.kind !== 'installed') return IDLE;
		try {
			const flag = lstatSync(join(config.dataDir, UPDATE_FLAG));
			return {
				phase: 'requested',
				from: this.#current,
				to: null,
				message: 'Waiting for the updater to start.',
				atIso: flag.mtime.toISOString()
			};
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		try {
			const status = updaterStatusSchema.parse(
				JSON.parse(readBounded(join(config.dataDir, UPDATE_STATUS), 32 * 1024).toString('utf8'))
			);
			return {
				phase: status.phase,
				from: status.from,
				to: status.to,
				message: status.message,
				atIso: new Date(status.atMs).toISOString()
			};
		} catch (error) {
			if (isMissing(error)) return IDLE;
			throw error;
		}
	}

	view(): ServerUpdateView {
		const config = this.#config;
		const operation = this.#operation();
		let reason = config.kind === 'source' ? SOURCE_RUN : '';
		const release =
			this.#cache.release !== null &&
			compareVersions(this.#cache.release.version, this.#current) > 0
				? this.#cache.release
				: null;
		if (reason === '' && release === null)
			reason =
				this.#cache.problem === null
					? 'No newer signed release is available.'
					: 'Could not confirm whether a newer signed release is available. Check for updates again.';
		if (
			reason === '' &&
			release !== null &&
			compareVersions(release.manifest.minimumLauncher, this.#current) > 0
		)
			reason = REINSTALL_ONCE;
		if (IN_PROGRESS.has(operation.phase)) reason = 'An update is already in progress.';
		return {
			installedVersion: this.#current,
			deployment: config.kind,
			...this.#cache,
			release,
			install: { allowed: reason === '', reason },
			operation,
			lastUpdateSteps: this.#lastUpdateSteps()
		};
	}

	/** Asks GitHub for the latest release; checks running at once share one request. */
	check(source: CheckSource, now: number): Promise<void> {
		if (this.#pending !== undefined) return this.#pending;
		this.#pending = this.#performCheck(source, now).finally(() => {
			this.#pending = undefined;
		});
		return this.#pending;
	}

	async #performCheck(source: CheckSource, now: number): Promise<void> {
		try {
			const release = await this.#latest();
			this.#cache = {
				checkedAtIso: new Date(now).toISOString(),
				lastSuccessAtIso: new Date(now).toISOString(),
				release,
				problem: null
			};
		} catch (error) {
			this.#cache = {
				...this.#cache,
				checkedAtIso: new Date(now).toISOString(),
				problem: error instanceof Error ? error.message : String(error)
			};
		}
		if (this.#config.kind === 'installed') {
			mkdirSync(this.#config.dataDir, { recursive: true });
			const path = join(this.#config.dataDir, CHECK_CACHE);
			writeFileSync(`${path}.new`, JSON.stringify(this.#cache), { mode: 0o600 });
			renameSync(`${path}.new`, path);
		}
		if (source === 'console') {
			const problem = this.#cache.problem;
			const offered = this.#cache.release?.version;
			this.#record({
				level: problem === null ? 'info' : 'warn',
				kind: 'update-checked',
				actor: 'console',
				summary:
					problem !== null
						? 'Checked for updates: the check failed'
						: offered === undefined
							? 'Checked for updates: Lookstow is up to date'
							: `Checked for updates: Lookstow ${offered} is available`,
				detail: problem
			});
		}
	}

	/**
	 * Update now: an empty flag file for the updater and nothing else. `version` is what the
	 * person confirmed; the updater picks the newest signed release itself.
	 */
	request(
		version: string,
		now: number,
		actor: 'console' | 'system' = 'console'
	): { requestedAtIso: string } {
		const view = this.view();
		if (
			this.#config.kind !== 'installed' ||
			!view.install.allowed ||
			view.release?.version !== version
		)
			throw new Error(
				view.install.reason === ''
					? 'Check for updates again before installing this version.'
					: view.install.reason
			);
		writeFileSync(join(this.#config.dataDir, UPDATE_FLAG), '', { flag: 'wx', mode: 0o600 });
		startWindowsUpdater();
		this.#record({
			level: 'info',
			kind: 'update-requested',
			actor,
			summary:
				actor === 'system'
					? `Automatic update to Lookstow ${version} started`
					: `Update to Lookstow ${version} requested`,
			detail: `From ${this.#current}. The updater restarts Lookstow; backups pause until it is back.`
		});
		return { requestedAtIso: new Date(now).toISOString() };
	}

	/** The last update's steps from the updater, or none (before the first one, or unreadable). */
	#lastUpdateSteps(): { step: string; atIso: string }[] {
		if (this.#config.kind !== 'installed') return [];
		try {
			const timings = updaterTimingsSchema.parse(
				JSON.parse(
					readBounded(join(this.#config.dataDir, UPDATE_TIMINGS), 16 * 1024).toString('utf8')
				)
			);
			return timings.steps.map((step) => ({
				step: step.step,
				atIso: new Date(step.atMs).toISOString()
			}));
		} catch {
			return [];
		}
	}

	/** Whether the daily check is due: a day after the last one, or 5 minutes after a failed one. */
	due(now: number): boolean {
		const checkedAt = this.#cache.checkedAtIso;
		return (
			checkedAt === null ||
			now - Date.parse(checkedAt) >= (this.#cache.problem === null ? DAY : FAILED_CHECK_RETRY)
		);
	}
}

/** This computer's target: the launcher's, or (a source run) the one this platform would use. */
function targetOf(config: LauncherConfig): ReleaseTarget {
	if (config.kind === 'installed') return config.target;
	return process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
}

export function makeServerUpdates(config: LauncherConfig, record: RecordActivity): ServerUpdates {
	const current = APP_VERSION;
	const target = targetOf(config);
	return new ServerUpdates(
		config,
		current,
		() => newestRelease(current, target, download, RELEASE_PUBLIC_KEY),
		record
	);
}

/**
 * On Windows the updater is a scheduled task that also runs every minute; the launcher lets
 * this service's account start it, so an update begins now instead of at the next minute (as
 * systemd's path unit does on Linux). If starting it is refused (a task registered by an older
 * release), the minute timer still runs it.
 */
function startWindowsUpdater(): void {
	if (process.platform !== 'win32') return;
	execFile(
		'schtasks.exe',
		['/Run', '/TN', WINDOWS_UPDATE_TASK],
		{ windowsHide: true, timeout: 15_000 },
		(error, stdout, stderr) => {
			if (error === null) {
				serverLog('info', 'update', 'Started the updater task');
			} else {
				// schtasks puts its reason on stderr; one line keeps it findable in server.log.
				const reason = `${stderr} ${stdout}`.split(/\s+/).join(' ').trim();
				serverLog(
					'warn',
					'update',
					`Could not start the updater task at once (exit ${String(error.code ?? 'unknown')}: ${reason === '' ? errorText(error) : reason}); it starts within a minute`
				);
			}
		}
	);
}
