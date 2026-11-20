import { Worker } from 'node:worker_threads';
import type { AlertRecipient, EmailView } from '../../domain/alerts.ts';
import type { EngineStatus } from '../../domain/engine.ts';
import type { IndexingProgress } from '../../domain/indexing.ts';
import type { LiveStatus } from '../../domain/live-status.ts';
import { errorText, serverLog, writeLogLine } from '../log.ts';
import { onActivity } from '../services/activity/activity.ts';
import type { LearnedPace } from '../services/graph/governor.ts';
import {
	isFromWork,
	type ToWork,
	type WorkAnswer,
	type WorkCall,
	type WorkSnapshot
} from './protocol.ts';

/**
 * The web thread's side of the work thread (docs/specs/SPEC-SCALE.md): it starts the thread,
 * keeps the latest snapshot for pages to read without waiting, and passes the console's requests
 * on. Calls the engine answers at once (Sync now, Cancel) are sent without waiting; the rest
 * wait for the work thread's answer. If the thread stops unexpectedly it is started again, and
 * meanwhile the live status says so.
 */
const RESTART_MS = 5_000;
const STOP_WAIT_MS = 9_000;
const DOWN = 'The backup engine stopped unexpectedly. It starts again in a few seconds.';

type Waiting = { resolve: (answer: WorkAnswer) => void; reject: (error: Error) => void };

export class WorkThread {
	readonly #entry: URL;
	readonly #version: string;
	#worker: Worker | null = null;
	#snapshot: WorkSnapshot | null = null;
	#down: string | null = null;
	#stopping = false;
	#nextId = 1;
	readonly #waiting = new Map<number, Waiting>();
	readonly #started: Promise<void>;
	#markStarted: () => void = () => undefined;
	#exited: Promise<void> = Promise.resolve();
	readonly #unsubscribe: () => void;

	constructor(entry: URL, version: string) {
		this.#entry = entry;
		this.#version = version;
		this.#started = new Promise((resolve) => {
			this.#markStarted = resolve;
		});
		// Email alerts run on the work thread: it hears about entries recorded here too.
		this.#unsubscribe = onActivity((_db, entry, now) => {
			this.#send({ type: 'activity', entry, now });
		});
		this.#spawn();
	}

	/** Resolves once the work thread has sent its first snapshot. */
	started(): Promise<void> {
		return this.#started;
	}

	#spawn(): void {
		const worker = new Worker(this.#entry, { workerData: { version: this.#version } });
		this.#worker = worker;
		this.#exited = new Promise((resolve) => {
			worker.once('exit', (code) => {
				this.#worker = null;
				for (const waiting of this.#waiting.values()) {
					waiting.reject(new Error('The backup engine restarted before it answered. Try again.'));
				}
				this.#waiting.clear();
				if (!this.#stopping) {
					this.#down = DOWN;
					serverLog(
						'error',
						'work',
						`The work thread stopped (exit code ${String(code)}); starting it again in ${String(RESTART_MS / 1000)} s`
					);
					// Not unref'd: before the first start, this timer is all that keeps the server up.
					setTimeout(() => {
						if (!this.#stopping) this.#spawn();
					}, RESTART_MS);
				}
				resolve();
			});
		});
		worker.on('error', (error) => {
			serverLog('error', 'work', `The work thread failed: ${errorText(error)}`);
		});
		worker.on('message', (message: unknown) => {
			this.#receive(message);
		});
	}

	#receive(message: unknown): void {
		if (!isFromWork(message)) return;
		switch (message.type) {
			case 'log':
				writeLogLine(message.level, message.area, message.message, message.at);
				return;
			case 'snapshot':
				this.#take(message.snapshot);
				return;
			case 'answer':
				this.#take(message.snapshot);
				this.#waiting.get(message.id)?.resolve(message.answer);
				this.#waiting.delete(message.id);
				return;
			case 'failed':
				this.#take(message.snapshot);
				this.#waiting.get(message.id)?.reject(new Error(message.error));
				this.#waiting.delete(message.id);
				return;
			case 'started':
				this.#markStarted();
				return;
			case 'stopped':
				return;
		}
	}

	#take(snapshot: WorkSnapshot | null): void {
		if (snapshot === null) return;
		this.#snapshot = snapshot;
		this.#down = null;
		this.#markStarted();
	}

	#send(message: ToWork): boolean {
		if (this.#worker === null) return false;
		this.#worker.postMessage(message);
		return true;
	}

	#call(call: WorkCall): Promise<WorkAnswer> {
		return new Promise((resolve, reject) => {
			const id = this.#nextId;
			this.#nextId += 1;
			this.#waiting.set(id, { resolve, reject });
			if (!this.#send({ type: 'call', id, call })) {
				this.#waiting.delete(id);
				reject(new Error(this.#down ?? 'The backup engine is not running.'));
			}
		});
	}

	/** Sends a call whose answer nobody waits for; a failure goes to the log. */
	#tell(call: WorkCall): void {
		this.#call(call).catch((error: unknown) => {
			serverLog('warn', 'work', `${call.name} failed: ${errorText(error)}`);
		});
	}

	#latest(): WorkSnapshot {
		if (this.#snapshot === null) throw new Error('The backup engine has not started yet.');
		return this.#snapshot;
	}

	/** The one live status every page reads (docs/specs/SPEC-STATUS.md), at most a second old. */
	live(): LiveStatus {
		const live = this.#latest().live;
		return this.#down === null
			? live
			: { ...live, engine: { ...live.engine, problem: this.#down } };
	}

	status(): EngineStatus {
		return this.live().engine;
	}

	snapshot(): WorkSnapshot {
		return this.#latest();
	}

	/** The search index's long work after an update, for the banner on every page. */
	indexing(): IndexingProgress | null {
		return this.#latest().indexing;
	}

	learnedPace(): LearnedPace {
		return this.#latest().learnedPace;
	}

	/** Why changes that touch the backup are refused now (it is moving), or null. */
	lockdown(): string | null {
		return this.#latest().lockdown;
	}

	requestDiscovery(): void {
		this.#tell({ name: 'requestDiscovery' });
	}

	requestSync(mailboxIds: string[] | null): void {
		this.#tell({ name: 'requestSync', mailboxIds });
	}

	cancel(mailboxId: string): void {
		this.#tell({ name: 'cancel', mailboxId });
	}

	async pause(
		reason: 'manual' | 'disk',
		actor: string,
		detail: string | null = null
	): Promise<void> {
		await this.#call({ name: 'pause', reason, actor, detail });
	}

	/** Throws with the reason when the engine will not resume (the drive is still full). */
	async resume(actor: string): Promise<void> {
		await this.#call({ name: 'resume', actor });
	}

	async waitUntilIdle(mailboxId: string, ms = 60_000): Promise<boolean> {
		const answer = await this.#call({ name: 'waitUntilIdle', mailboxId, ms });
		return answer.name === 'idle' && answer.value;
	}

	async startMove(to: string, actor: string): Promise<void> {
		await this.#call({ name: 'startMove', to, actor });
	}

	async cancelMove(actor: string): Promise<void> {
		await this.#call({ name: 'cancelMove', actor });
	}

	async removeOldCopy(actor: string): Promise<void> {
		await this.#call({ name: 'removeOldCopy', actor });
	}

	/**
	 * Alerts' Send a test, by the work thread's alerts: one sender, so an email due at the same
	 * moment is never sent twice.
	 */
	async sendTestAlert(recipient: AlertRecipient, by: string): Promise<EmailView | null> {
		const answer = await this.#call({ name: 'sendTestAlert', recipient, by });
		if (answer.name !== 'testAlert') throw new Error('The work thread answered the wrong call.');
		return answer.value;
	}

	async forgetPace(): Promise<void> {
		await this.#call({ name: 'forgetPace' });
	}

	/** Lets the engine finish its pages and the indexes their batches, then ends the thread. */
	async stop(): Promise<void> {
		this.#stopping = true;
		this.#unsubscribe();
		const worker = this.#worker;
		if (worker === null) return;
		this.#send({ type: 'stop' });
		const late = new Promise<'late'>((resolve) => {
			setTimeout(() => {
				resolve('late');
			}, STOP_WAIT_MS).unref();
		});
		if ((await Promise.race([this.#exited, late])) === 'late') await worker.terminate();
	}
}
