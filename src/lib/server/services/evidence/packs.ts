import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../../database/connection.ts';
import { mailboxes, mailFolders, messages } from '../../database/schema.ts';
import {
	PACK_MAX_MESSAGES,
	packExpired,
	packName,
	packNow,
	type EvidencePack
} from '../../../domain/evidence-packs.ts';
import type { PackMessage } from './pack-contents.ts';

/**
 * Evidence packs on disk (docs/specs/SPEC-EVIDENCE-PACKS.md): each in
 * `<data>/evidence-packs/<id>/` with `pack.json` (its state), `request.json` (the messages, in
 * order), the ZIP (`pack.zip`, `pack.zip.part` while it is written) and `cancel` when someone
 * asked to stop it. The data folder is the service's and administrators' only, which a pack of
 * mail needs. Any thread reads a pack's state from its files; only the reading thread builds.
 */
export const PACKS_FOLDER = 'evidence-packs';
const LOOKUP_CHUNK = 500;
/** Room kept free on the drive besides the pack itself. */
const SPARE_BYTES = 512 * 1024 * 1024;

const packSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	createdBy: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	status: z.enum(['queued', 'building', 'ready', 'failed']),
	withAttachments: z.boolean(),
	total: z.number(),
	done: z.number(),
	sourceBytes: z.number(),
	missing: z.array(z.string()),
	mismatched: z.number(),
	unreadable: z.number(),
	zipBytes: z.number().nullable(),
	sha256: z.string().nullable(),
	finishedAt: z.string().nullable(),
	expiresAt: z.string().nullable(),
	problem: z.string().nullable()
});

const requestSchema = z.object({ ids: z.array(z.string()) });

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function packsFolder(dataDir: string): string {
	return join(dataDir, PACKS_FOLDER);
}

/** A pack's folder; the id is checked, so it never leaves the packs folder. */
export function packFolder(dataDir: string, id: string): string {
	if (!ID.test(id)) throw new Error('Not a pack id');
	return join(packsFolder(dataDir), id);
}

export function packZipPath(dataDir: string, id: string): string {
	return join(packFolder(dataDir, id), 'pack.zip');
}

/** Writes pack.json whole (a temporary file, then a rename), so a reader never sees half. */
export async function savePack(dataDir: string, pack: EvidencePack): Promise<void> {
	const folder = packFolder(dataDir, pack.id);
	const temporary = join(folder, `pack.json.${randomUUID()}.tmp`);
	await writeFile(temporary, JSON.stringify(pack, null, 1), { mode: 0o600 });
	await rename(temporary, join(folder, 'pack.json'));
}

export async function readPack(dataDir: string, id: string): Promise<EvidencePack | null> {
	try {
		const parsed = packSchema.safeParse(
			JSON.parse(await readFile(join(packFolder(dataDir, id), 'pack.json'), 'utf8'))
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export async function readRequest(dataDir: string, id: string): Promise<string[] | null> {
	try {
		const parsed = requestSchema.safeParse(
			JSON.parse(await readFile(join(packFolder(dataDir, id), 'request.json'), 'utf8'))
		);
		return parsed.success ? parsed.data.ids : null;
	} catch {
		return null;
	}
}

/**
 * Every pack, newest first, as it stands now: one a stopped service left building has failed,
 * and packs past their keeping time are removed (with an entry for the log).
 */
export async function listPacks(
	dataDir: string,
	now = Date.now()
): Promise<{ packs: EvidencePack[]; removed: EvidencePack[] }> {
	let names: string[];
	try {
		names = await readdir(packsFolder(dataDir));
	} catch {
		return { packs: [], removed: [] };
	}
	const packs: EvidencePack[] = [];
	const removed: EvidencePack[] = [];
	for (const name of names) {
		if (!ID.test(name)) continue;
		const stored = await readPack(dataDir, name);
		if (stored === null) continue;
		const pack = packNow(stored, now);
		if (packExpired(pack, now)) {
			await rm(packFolder(dataDir, name), { recursive: true, force: true });
			removed.push(pack);
			continue;
		}
		packs.push(pack);
	}
	packs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return { packs, removed };
}

/** The messages' details for a pack, in the order given, in chunks (thousands of ids). */
export function packMessages(db: Queryable, ids: readonly string[]): PackMessage[] {
	const found = new Map<string, PackMessage>();
	for (let start = 0; start < ids.length; start += LOOKUP_CHUNK) {
		const rows = db
			.select({
				id: messages.id,
				mailboxAddress: mailboxes.address,
				mailboxKind: mailboxes.kind,
				folderPath: mailFolders.path,
				subject: messages.subject,
				sender: messages.sender,
				recipients: messages.recipients,
				receivedAt: messages.receivedAt,
				internetMessageId: messages.internetMessageId,
				filePath: messages.filePath,
				sha256: messages.sha256,
				storedAt: messages.storedAt,
				deletedAt: messages.deletedAt,
				byteCount: messages.byteCount
			})
			.from(messages)
			.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
			.innerJoin(mailFolders, eq(messages.folderId, mailFolders.id))
			.where(inArray(messages.id, ids.slice(start, start + LOOKUP_CHUNK)))
			.orderBy(asc(messages.id))
			.all();
		for (const row of rows) found.set(row.id, row);
	}
	return ids.flatMap((id) => {
		const message = found.get(id);
		return message === undefined ? [] : [message];
	});
}

export type PackPlan = {
	found: string[];
	missing: string[];
	repeats: number;
	sourceBytes: number;
	/** Free space on the data folder's drive, or null when it could not be read. */
	freeBytes: number | null;
	/** Why it cannot be built, or null. */
	refusal: string | null;
};

/** Bytes a pack may need at most: every message stored as is, and again when unpacked. */
export function bytesNeeded(sourceBytes: number, withAttachments: boolean): number {
	return Math.ceil(sourceBytes * (withAttachments ? 2.1 : 1.05)) + SPARE_BYTES;
}

async function freeSpace(dataDir: string): Promise<number | null> {
	try {
		const stats = await statfs(dataDir);
		return stats.bavail * stats.bsize;
	} catch {
		return null;
	}
}

/** Which of the ids Lookstow has, how big the pack is, and whether there is room to make it. */
export async function planPack(
	db: Queryable,
	dataDir: string,
	ids: readonly string[],
	repeats: number,
	withAttachments: boolean
): Promise<PackPlan> {
	const empty = { found: [], missing: [...ids], repeats, sourceBytes: 0, freeBytes: null };
	if (ids.length === 0) {
		return { ...empty, missing: [], refusal: 'No message ids were found in what was given.' };
	}
	if (ids.length > PACK_MAX_MESSAGES) {
		return {
			...empty,
			refusal: `A pack holds at most ${PACK_MAX_MESSAGES.toLocaleString('en-AU')} messages; split it into several.`
		};
	}
	const rows = packMessages(db, ids);
	const have = new Set(rows.map((row) => row.id));
	const sourceBytes = rows.reduce((sum, row) => sum + row.byteCount, 0);
	const freeBytes = await freeSpace(dataDir);
	let refusal: string | null = null;
	if (rows.length === 0) refusal = 'None of these messages are in the backup.';
	else if (freeBytes !== null && freeBytes < bytesNeeded(sourceBytes, withAttachments)) {
		refusal = `Not enough free space on the data folder's drive: the pack needs up to ${String(Math.ceil(bytesNeeded(sourceBytes, withAttachments) / 1e9))} GB and ${String(Math.floor(freeBytes / 1e9))} GB is free. Remove old packs or make a smaller one.`;
	}
	return {
		found: rows.map((row) => row.id),
		missing: ids.filter((id) => !have.has(id)),
		repeats,
		sourceBytes,
		freeBytes,
		refusal
	};
}

/** Writes a new pack, queued, from a plan that was not refused. */
export async function createPack(
	dataDir: string,
	plan: PackPlan,
	request: { name: string; createdBy: string; withAttachments: boolean },
	now = Date.now()
): Promise<EvidencePack> {
	if (plan.refusal !== null) throw new Error(plan.refusal);
	const at = new Date(now);
	const pack: EvidencePack = {
		id: randomUUID(),
		name: packName(request.name, at),
		createdBy: request.createdBy,
		createdAt: at.toISOString(),
		updatedAt: at.toISOString(),
		status: 'queued',
		withAttachments: request.withAttachments,
		total: plan.found.length,
		done: 0,
		sourceBytes: plan.sourceBytes,
		missing: plan.missing,
		mismatched: 0,
		unreadable: 0,
		zipBytes: null,
		sha256: null,
		finishedAt: null,
		expiresAt: null,
		problem: null
	};
	const folder = packFolder(dataDir, pack.id);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	await writeFile(join(folder, 'request.json'), JSON.stringify({ ids: plan.found }), {
		mode: 0o600
	});
	await savePack(dataDir, pack);
	return pack;
}

/** Puts a failed pack back in the queue, as it was asked for. */
export async function requeuePack(
	dataDir: string,
	pack: EvidencePack,
	now = Date.now()
): Promise<EvidencePack> {
	await rm(join(packFolder(dataDir, pack.id), 'pack.zip.part'), { force: true });
	const again: EvidencePack = {
		...pack,
		status: 'queued',
		done: 0,
		mismatched: 0,
		unreadable: 0,
		zipBytes: null,
		sha256: null,
		finishedAt: null,
		expiresAt: null,
		problem: null,
		updatedAt: new Date(now).toISOString()
	};
	await savePack(dataDir, again);
	return again;
}

/**
 * Removes a pack. One being made is asked to stop (the reading thread removes it when it sees
 * `cancel`); anything else is removed at once.
 */
export async function removePack(dataDir: string, pack: EvidencePack): Promise<void> {
	const folder = packFolder(dataDir, pack.id);
	if (pack.status === 'queued' || pack.status === 'building') {
		await writeFile(join(folder, 'cancel'), '', { mode: 0o600 });
		return;
	}
	await rm(folder, { recursive: true, force: true });
}

export function cancelAsked(dataDir: string, id: string): boolean {
	return existsSync(join(packFolder(dataDir, id), 'cancel'));
}
