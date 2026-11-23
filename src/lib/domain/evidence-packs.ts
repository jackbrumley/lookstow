/**
 * Evidence packs (docs/specs/SPEC-EVIDENCE-PACKS.md): a ZIP of chosen messages, with a manifest
 * and their SHA-256s, to hand to a lawyer. Browser-safe shapes and pure rules.
 */

/** Messages in one pack, at most. */
export const PACK_MAX_MESSAGES = 50_000;
/** A pack is removed this long after it was finished (or failed). */
export const PACK_KEEP_DAYS = 7;
/** A pack still marked building or queued that has not moved for this long was interrupted. */
export const PACK_STALE_MS = 60_000;

export type PackStatus = 'queued' | 'building' | 'ready' | 'failed';

export type EvidencePack = {
	id: string;
	name: string;
	/** Who asked for it: `console`, a remote account's name, or `AI agent`. */
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	status: PackStatus;
	withAttachments: boolean;
	/** Messages found and going in. */
	total: number;
	/** Messages written so far. */
	done: number;
	/** The stored size of the messages going in. */
	sourceBytes: number;
	/** Ids asked for that Lookstow does not have. */
	missing: string[];
	/** Messages whose stored file no longer matches the SHA-256 recorded when it was backed up. */
	mismatched: number;
	/** Messages that could not be read at all (listed in the pack's README). */
	unreadable: number;
	zipBytes: number | null;
	sha256: string | null;
	finishedAt: string | null;
	expiresAt: string | null;
	problem: string | null;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The message ids in whatever was pasted: a column from a spreadsheet, a list of links to
 * /messages/<id>, or a whole block of text. In the order first seen, lower case, without repeats.
 */
export function messageIdsIn(text: string): { ids: string[]; repeats: number } {
	const seen = new Set<string>();
	let repeats = 0;
	for (const match of text.matchAll(UUID)) {
		const id = match[0].toLowerCase();
		if (seen.has(id)) repeats += 1;
		else seen.add(id);
	}
	return { ids: [...seen], repeats };
}

/** A pack's name: what people typed, kept to letters, digits, spaces and simple punctuation. */
export function packName(typed: string, now: Date): string {
	const cleaned = typed
		.replace(/[^\p{L}\p{N} ._()&,'-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80)
		.replace(/[. ]+$/, '');
	// The local date (en-CA writes YYYY-MM-DD), as every time in Lookstow is local.
	return cleaned === '' ? `Evidence pack ${now.toLocaleDateString('en-CA')}` : cleaned;
}

/** What a pack's state is now: one left building or queued by a stopped service has failed. */
export function packNow(pack: EvidencePack, now: number): EvidencePack {
	const waiting = pack.status === 'queued' || pack.status === 'building';
	if (!waiting || now - Date.parse(pack.updatedAt) < PACK_STALE_MS) return pack;
	return {
		...pack,
		status: 'failed',
		problem: 'Lookstow stopped while this pack was being made. Build it again.'
	};
}

/** Whether a finished or failed pack is past its keeping time. */
export function packExpired(pack: EvidencePack, now: number): boolean {
	return pack.expiresAt !== null && Date.parse(pack.expiresAt) <= now;
}

/** One line for the page and the AI tools: where the pack is up to. */
export function packProgress(pack: EvidencePack): string {
	switch (pack.status) {
		case 'queued':
			return 'Waiting to start (one pack is made at a time)';
		case 'building':
			return `${String(pack.done)} of ${String(pack.total)} messages written`;
		case 'ready':
			return 'Ready to download';
		case 'failed':
			return pack.problem ?? 'Failed';
	}
}

/** A safe file or folder name inside the ZIP (Windows rules, which are the strictest). */
export function zipSafeName(text: string, most: number): string {
	const cleaned = text
		.replace(/[\p{Cc}<>:"/\\|?*]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, most)
		.replace(/[. ]+$/, '');
	return cleaned === '' ? '(none)' : cleaned;
}
