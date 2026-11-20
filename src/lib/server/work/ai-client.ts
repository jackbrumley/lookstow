import { Worker } from 'node:worker_threads';
import { errorText, serverLog, writeLogLine } from '../log.ts';
import type { McpReply } from '../services/ai/mcp.ts';
import { isFromAi, type AiAnswer, type AiCall, type ToAi } from './ai-protocol.ts';
import type { AttachmentReply } from './protocol.ts';

/**
 * The web thread's side of the AI tools' thread (docs/specs/SPEC-SCALE.md). The thread starts
 * with the first AI call (an install that never turns AI tools on never starts it) and again
 * with the next call if it stopped.
 */
type Waiting = { resolve: (answer: AiAnswer) => void; reject: (error: Error) => void };

const STOP_WAIT_MS = 5_000;

export class AiThread {
	readonly #entry: URL;
	readonly #version: string;
	#worker: Worker | null = null;
	#nextId = 1;
	readonly #waiting = new Map<number, Waiting>();
	#exited: Promise<void> = Promise.resolve();

	constructor(entry: URL, version: string) {
		this.#entry = entry;
		this.#version = version;
	}

	#running(): Worker {
		if (this.#worker !== null) return this.#worker;
		const worker = new Worker(this.#entry, { workerData: { version: this.#version } });
		this.#worker = worker;
		this.#exited = new Promise((resolve) => {
			worker.once('exit', (code) => {
				if (this.#worker === worker) this.#worker = null;
				for (const waiting of this.#waiting.values()) {
					waiting.reject(new Error('The AI tools restarted before they answered. Try again.'));
				}
				this.#waiting.clear();
				if (code !== 0) {
					serverLog('error', 'ai', `The AI tools' thread stopped (exit code ${String(code)})`);
				}
				resolve();
			});
		});
		worker.on('error', (error) => {
			serverLog('error', 'ai', `The AI tools' thread failed: ${errorText(error)}`);
		});
		worker.on('message', (message: unknown) => {
			if (!isFromAi(message)) return;
			switch (message.type) {
				case 'log':
					writeLogLine(message.level, message.area, message.message, message.at);
					return;
				case 'answer':
					this.#waiting.get(message.id)?.resolve(message.answer);
					this.#waiting.delete(message.id);
					return;
				case 'failed':
					this.#waiting.get(message.id)?.reject(new Error(message.error));
					this.#waiting.delete(message.id);
					return;
				case 'started':
					return;
			}
		});
		return worker;
	}

	#call(call: AiCall): Promise<AiAnswer> {
		const worker = this.#running();
		return new Promise((resolve, reject) => {
			const id = this.#nextId;
			this.#nextId += 1;
			this.#waiting.set(id, { resolve, reject });
			const message: ToAi = { type: 'call', id, call };
			worker.postMessage(message);
		});
	}

	async mcp(message: unknown, baseUrl: string): Promise<McpReply> {
		const answer = await this.#call({ name: 'mcp', message, baseUrl });
		if (answer.name !== 'mcp') throw new Error('The AI tools answered the wrong call.');
		return answer.value;
	}

	async attachment(messageId: string, index: number, baseUrl: string): Promise<AttachmentReply> {
		const answer = await this.#call({ name: 'attachment', messageId, index, baseUrl });
		if (answer.name !== 'attachment') throw new Error('The AI tools answered the wrong call.');
		return answer.value;
	}

	/** Lets the call under way finish, then ends the thread. */
	async stop(): Promise<void> {
		const worker = this.#worker;
		if (worker === null) return;
		const message: ToAi = { type: 'stop' };
		worker.postMessage(message);
		const late = new Promise<'late'>((resolve) => {
			setTimeout(() => {
				resolve('late');
			}, STOP_WAIT_MS).unref();
		});
		if ((await Promise.race([this.#exited, late])) === 'late') await worker.terminate();
	}
}
