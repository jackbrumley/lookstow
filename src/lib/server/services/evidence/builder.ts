import { createHash } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Queryable } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import { recordActivity } from '../activity/activity.ts';
import { parseEml } from '../ai/mime.ts';
import { archiveItemAsEml } from '../fts/fts-download.ts';
import { resolveStoragePath } from '../storage/eml-store.ts';
import { APP_VERSION } from '../../../utils/app-version.ts';
import { PACK_KEEP_DAYS, zipSafeName, type EvidencePack } from '../../../domain/evidence-packs.ts';
import {
	attachmentName,
	indexHtml,
	manifestCsv,
	PackNames,
	readmeText,
	sumsText,
	type FileCheck,
	type ManifestRow,
	type PackMessage
} from './pack-contents.ts';
import { cancelAsked, packFolder, packMessages, readPack, readRequest, savePack } from './packs.ts';
import { ZipWriter } from './zip-writer.ts';

/**
 * Makes evidence packs on the reading thread (docs/specs/SPEC-EVIDENCE-PACKS.md), one at a time
 * in the order asked. Compression runs on Node's worker pool and files are read and written
 * asynchronously, so the AI tools and the viewer still answer while a pack is made. Every few
 * seconds each pack in hand has its state written, which is also how a pack left behind by a
 * stopped service is told apart (it stops moving).
 */
const HEARTBEAT_MS = 5_000;
const CANCEL_CHECK_EVERY = 20;

export type BuildContext = { db: Queryable; dataDir: string; backupRoot: () => string };

class Cancelled extends Error {}

function sha256(data: Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

/** The message's .eml and how its stored file checked out, or null when it cannot be read. */
async function messageEml(
	context: BuildContext,
	message: PackMessage
): Promise<{ eml: Buffer; check: FileCheck } | null> {
	const root = context.backupRoot();
	let stored: Buffer;
	try {
		stored = await readFile(resolveStoragePath(root, message.filePath));
	} catch {
		return null;
	}
	const matches = sha256(stored) === message.sha256;
	if (!message.filePath.endsWith('.fts')) {
		return { eml: stored, check: matches ? 'matches' : 'MISMATCH' };
	}
	const converted = await archiveItemAsEml(context.db, root, message.id);
	if (converted.kind === 'refused') return null;
	return { eml: converted.eml, check: matches ? 'converted' : 'MISMATCH' };
}

export class PackBuilder {
	readonly #context: BuildContext;
	readonly #queue: string[] = [];
	/** The packs in hand (queued and the one being made), as last written. */
	readonly #held = new Map<string, EvidencePack>();
	#running = false;
	#heartbeat: ReturnType<typeof setInterval> | null = null;

	constructor(context: BuildContext) {
		this.#context = context;
	}

	/** Adds a queued pack (already written by createPack) to the line. */
	async enqueue(id: string): Promise<void> {
		if (this.#held.has(id)) return;
		const pack = await readPack(this.#context.dataDir, id);
		if (pack?.status !== 'queued') return;
		this.#held.set(id, pack);
		this.#queue.push(id);
		this.#startHeartbeat();
		void this.#drain();
	}

	#startHeartbeat(): void {
		if (this.#heartbeat !== null) return;
		this.#heartbeat = setInterval(() => {
			void this.#beat();
		}, HEARTBEAT_MS);
		this.#heartbeat.unref();
	}

	/**
	 * Writes go one after another, each writing the pack's latest state, so a heartbeat can never
	 * put back an older state over a newer one.
	 */
	#writes: Promise<void> = Promise.resolve();

	#persist(id: string): Promise<void> {
		const write = this.#writes.then(async () => {
			const pack = this.#held.get(id);
			if (pack === undefined) return;
			await savePack(this.#context.dataDir, { ...pack, updatedAt: new Date().toISOString() });
		});
		this.#writes = write.catch(() => {
			// Removed meanwhile: the build notices and stops.
		});
		return write;
	}

	async #beat(): Promise<void> {
		for (const id of [...this.#held.keys()]) await this.#persist(id).catch(() => undefined);
		if (this.#held.size === 0 && this.#heartbeat !== null) {
			clearInterval(this.#heartbeat);
			this.#heartbeat = null;
		}
	}

	/** Records the pack's new state and writes it. */
	async #save(pack: EvidencePack): Promise<void> {
		this.#held.set(pack.id, pack);
		await this.#persist(pack.id);
	}

	async #drain(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			for (let id = this.#queue.shift(); id !== undefined; id = this.#queue.shift()) {
				const pack = this.#held.get(id);
				if (pack !== undefined) await this.#build(pack);
				this.#held.delete(id);
			}
		} finally {
			this.#running = false;
		}
	}

	async #build(queued: EvidencePack): Promise<void> {
		const { dataDir, db } = this.#context;
		const folder = packFolder(dataDir, queued.id);
		const partPath = join(folder, 'pack.zip.part');
		let zip: ZipWriter | null = null;
		let pack: EvidencePack = { ...queued, status: 'building' };
		try {
			if (cancelAsked(dataDir, pack.id)) throw new Cancelled();
			await this.#save(pack);
			const ids = await readRequest(dataDir, pack.id);
			if (ids === null) throw new Error('The pack’s list of messages is missing');
			const found = packMessages(db, ids);
			await rm(partPath, { force: true });
			zip = await ZipWriter.create(partPath);
			const top = zipSafeName(pack.name, 80);
			const names = new PackNames();
			const rows: ManifestRow[] = [];
			const sums: { path: string; sha256: string }[] = [];
			const add = async (path: string, data: Buffer, when: Date): Promise<void> => {
				if (zip === null) throw new Error('The ZIP file is closed');
				await zip.add(`${top}/${path}`, data, when);
				sums.push({ path, sha256: sha256(data) });
			};
			pack = { ...pack, total: found.length };
			for (const [index, message] of found.entries()) {
				if (index % CANCEL_CHECK_EVERY === 0 && cancelAsked(dataDir, pack.id)) {
					throw new Cancelled();
				}
				const read = await messageEml(this.#context, message);
				if (read === null) {
					rows.push({ message, file: null, fileSha256: null, check: 'MISSING', attachments: 0 });
					pack = { ...pack, unreadable: pack.unreadable + 1, done: pack.done + 1 };
					this.#held.set(pack.id, pack);
					continue;
				}
				const base = names.base(message);
				const when = message.receivedAt ?? message.storedAt;
				await add(`${base}.eml`, read.eml, when);
				let attachments = 0;
				if (pack.withAttachments) {
					const folderName = `attachments/${base.slice('messages/'.length)}`;
					for (const [position, attachment] of parseEml(read.eml).attachments.entries()) {
						await add(
							`${folderName}/${attachmentName(position, attachment.filename)}`,
							attachment.data,
							when
						);
						attachments += 1;
					}
				}
				rows.push({
					message,
					file: `${base}.eml`,
					fileSha256: sha256(read.eml),
					check: read.check,
					attachments
				});
				pack = {
					...pack,
					done: pack.done + 1,
					mismatched: pack.mismatched + (read.check === 'MISMATCH' ? 1 : 0)
				};
				// The heartbeat writes the count.
				this.#held.set(pack.id, pack);
			}
			const now = new Date();
			await add('manifest.csv', Buffer.from(manifestCsv(rows), 'utf8'), now);
			await add('index.html', Buffer.from(indexHtml(pack, rows), 'utf8'), now);
			await add('README.txt', Buffer.from(readmeText(pack, rows, APP_VERSION), 'utf8'), now);
			await zip.add(`${top}/SHA256SUMS.txt`, Buffer.from(sumsText(sums), 'utf8'), now);
			const finished = await zip.finish();
			zip = null;
			if (cancelAsked(dataDir, pack.id)) throw new Cancelled();
			await rename(partPath, join(folder, 'pack.zip'));
			const at = Date.now();
			pack = {
				...pack,
				status: 'ready',
				zipBytes: finished.bytes,
				sha256: finished.sha256,
				finishedAt: new Date(at).toISOString(),
				expiresAt: new Date(at + PACK_KEEP_DAYS * 86_400_000).toISOString()
			};
			await this.#save(pack);
			recordActivity(db, {
				level: pack.mismatched + pack.unreadable > 0 ? 'warn' : 'info',
				kind: 'evidence-pack',
				actor: pack.createdBy,
				summary: `Evidence pack ready: ${pack.name}`,
				detail: `${String(pack.done - pack.unreadable)} messages, ${String(finished.bytes)} bytes, SHA-256 ${finished.sha256}.${pack.mismatched > 0 ? ` ${String(pack.mismatched)} stored files no longer match their recorded SHA-256.` : ''}${pack.unreadable > 0 ? ` ${String(pack.unreadable)} could not be read.` : ''}${pack.missing.length > 0 ? ` ${String(pack.missing.length)} ids asked for are not in the backup.` : ''}`
			});
		} catch (error) {
			await zip?.abandon().catch(() => undefined);
			if (error instanceof Cancelled) {
				await rm(folder, { recursive: true, force: true });
				recordActivity(db, {
					level: 'info',
					kind: 'evidence-pack',
					actor: pack.createdBy,
					summary: `Evidence pack stopped and removed: ${pack.name}`
				});
				return;
			}
			await rm(partPath, { force: true }).catch(() => undefined);
			const problem = `The pack could not be made: ${errorText(error)}`;
			serverLog('error', 'evidence-pack', `${pack.name}: ${problem}`);
			const at = Date.now();
			pack = {
				...pack,
				status: 'failed',
				problem,
				finishedAt: new Date(at).toISOString(),
				expiresAt: new Date(at + PACK_KEEP_DAYS * 86_400_000).toISOString()
			};
			await this.#save(pack).catch(() => undefined);
			recordActivity(db, {
				level: 'error',
				kind: 'evidence-pack',
				actor: pack.createdBy,
				summary: `Evidence pack failed: ${pack.name}`,
				detail: problem
			});
		}
	}
}
