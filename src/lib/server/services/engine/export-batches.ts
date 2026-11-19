import { EXPORT_BATCH } from '../graph/archive.ts';

/**
 * How online archive items are exported fast without running out of memory
 * (docs/specs/SPEC-THROUGHPUT.md 4.3 and 4.4). Export replies carry whole items as base64 inside
 * JSON, so they cannot be streamed: batches are limited by size as well as count, several run at
 * once (the governor keeps each mailbox within what Microsoft allows), and all of them together
 * stay inside one byte budget.
 */

/** Batches a mailbox exports at once; the governor's lane is the real limit (4 at first). */
export const EXPORT_PARALLEL = 6;
/**
 * Items in a batch add up to at most this, unless one item alone is bigger. Smaller replies are
 * less often cut off by Microsoft (32 MB batches broke off on a real archive), and several run at
 * once anyway.
 */
export const EXPORT_BATCH_BYTES = 8 * 1024 * 1024;
/** Export replies held in memory at once, across every archive syncing. */
const EXPORT_BUDGET_BYTES = 256 * 1024 * 1024;

/**
 * Items at least this big are exported on their own and tried once per sync: Microsoft sends
 * archive exports slowly, so one such reply can take many minutes, and when it breaks off,
 * asking again straight away only holds up the rest of the folder. The item is recorded and
 * tried again on later syncs instead.
 */
export const GIANT_ITEM_BYTES = 25 * 1024 * 1024;

export type ExportItem = { id: string; size: number | null };

export type ExportBatch = { ids: string[]; bytes: number; giant: boolean };

/**
 * Splits items into export batches: at most EXPORT_BATCH items and EXPORT_BATCH_BYTES each;
 * each giant item alone, after the rest, so the ordinary items are stored first.
 */
export function exportBatches(items: readonly ExportItem[]): ExportBatch[] {
	const batches: ExportBatch[] = [];
	const giants: ExportBatch[] = [];
	let current: ExportBatch = { ids: [], bytes: 0, giant: false };
	for (const item of items) {
		// An export reply is base64: a third larger than the item.
		const bytes = Math.ceil(((item.size ?? 0) * 4) / 3);
		if ((item.size ?? 0) >= GIANT_ITEM_BYTES) {
			giants.push({ ids: [item.id], bytes, giant: true });
			continue;
		}
		const full =
			current.ids.length >= EXPORT_BATCH ||
			(current.ids.length > 0 && current.bytes + bytes > EXPORT_BATCH_BYTES);
		if (full) {
			batches.push(current);
			current = { ids: [], bytes: 0, giant: false };
		}
		current.ids.push(item.id);
		current.bytes += bytes;
	}
	if (current.ids.length > 0) batches.push(current);
	return [...batches, ...giants];
}

/**
 * A budget of bytes shared by everything that holds export replies. Taking more than is free
 * waits; one taker may always go when nothing else holds any, so a single huge item is never
 * stuck.
 */
export class ByteBudget {
	readonly #limit: number;
	#used = 0;
	readonly #waiting: { bytes: number; resolve: (release: () => void) => void }[] = [];

	constructor(limit: number) {
		this.#limit = limit;
	}

	get used(): number {
		return this.#used;
	}

	take(bytes: number): Promise<() => void> {
		return new Promise((resolve) => {
			this.#waiting.push({ bytes, resolve });
			this.#grant();
		});
	}

	#grant(): void {
		for (;;) {
			const next = this.#waiting[0];
			if (next === undefined) return;
			if (this.#used > 0 && this.#used + next.bytes > this.#limit) return;
			this.#waiting.shift();
			this.#used += next.bytes;
			let released = false;
			next.resolve(() => {
				if (released) return;
				released = true;
				this.#used -= next.bytes;
				this.#grant();
			});
		}
	}
}

/** The budget every archive sync in this process shares. */
export const exportBudget = new ByteBudget(EXPORT_BUDGET_BYTES);
