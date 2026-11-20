import type { Queryable } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import { indexNewHeaders, metaValue, pruneContent, setMetaValue } from './headers.ts';
import { hasLegacyContent, moveLegacyContent } from './legacy-content.ts';

/**
 * Keeps the search index up to date on the work thread (docs/specs/SPEC-SCALE.md): every few
 * seconds it indexes the messages stored since its last pass, then (once) moves the content
 * index left in the main file by an older Lookstow, and once a day removes the entries of
 * messages no longer stored. It works a batch at a time and lets the engine run between batches.
 */
const EVERY_MS = 5_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const PRUNED_AT = 'pruned_at';
const REPORT_EVERY = 50_000;
/**
 * The old content table moves only after the service has run this long: an update the updater
 * rolls back (it decides within two minutes) leaves the database as the older Lookstow knew it.
 */
const MOVE_AFTER_MS = 10 * 60_000;

function nextTurn(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

export type SearchIndexKeeper = { stop: () => Promise<void> };

export function startSearchIndex(db: Queryable, now: () => number = Date.now): SearchIndexKeeper {
	const state: {
		stopping: boolean;
		running: Promise<void>;
		timer: NodeJS.Timeout | null;
	} = { stopping: false, running: Promise.resolve(), timer: null };
	const startedAt = now();

	const stopped = (): boolean => state.stopping;
	const catchUp = async (): Promise<void> => {
		const started = now();
		let read = 0;
		let reported = 0;
		for (;;) {
			if (stopped()) return;
			const batch = indexNewHeaders(db);
			if (batch === 0) break;
			read += batch;
			if (read - reported >= REPORT_EVERY) {
				reported = read;
				serverLog('info', 'search-index', `Search index: ${String(read)} messages added so far`);
			}
			await nextTurn();
		}
		if (read >= REPORT_EVERY) {
			serverLog(
				'info',
				'search-index',
				`Search index: ${String(read)} messages added in ${String(Math.round((now() - started) / 1000))} s`
			);
		}
		if (now() - startedAt >= MOVE_AFTER_MS && hasLegacyContent(db)) {
			let moved = 0;
			for (;;) {
				if (stopped()) return;
				const batch = moveLegacyContent(db);
				if (batch === null) break;
				moved += batch;
				await nextTurn();
			}
			serverLog(
				'info',
				'search-index',
				`Moved the AI tools' content index (${String(moved)} messages) to lookstow-content.db`
			);
		}
		// Kept in the content file, so restarts (updates, reboots) do not keep putting it off.
		if (now() - (metaValue(db, PRUNED_AT) ?? 0) >= PRUNE_EVERY_MS) {
			setMetaValue(db, PRUNED_AT, now());
			let after: number | null = 0;
			while (after !== null && !stopped()) {
				after = pruneContent(db, after);
				await nextTurn();
			}
		}
	};

	const run = (): void => {
		state.running = catchUp()
			.catch((error: unknown) => {
				serverLog('warn', 'search-index', `Search index stopped a pass: ${errorText(error)}`);
			})
			.finally(() => {
				if (!state.stopping) {
					state.timer = setTimeout(run, EVERY_MS);
					state.timer.unref();
				}
			});
	};
	run();
	return {
		stop: async () => {
			state.stopping = true;
			if (state.timer !== null) clearTimeout(state.timer);
			await state.running;
		}
	};
}
