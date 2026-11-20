import { sql } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import { progressLine, type IndexingProgress } from '../../../domain/indexing.ts';
import {
	headersCursor,
	indexNewHeaders,
	metaValue,
	pruneContent,
	setMetaValue
} from './headers.ts';
import { legacyContentLeft, hasLegacyContent, moveLegacyContent } from './legacy-content.ts';

/**
 * Keeps the search index up to date on the work thread (docs/specs/SPEC-SCALE.md): every few
 * seconds it indexes the messages stored since its last pass, then (once) moves the content
 * index left in the main file by an older Lookstow, and once a day removes the entries of
 * messages no longer stored. It works a batch at a time and lets the engine run between batches.
 *
 * Long work (the first build after an update, a walk after a deleted backup, the move) is shown
 * as it goes: `progress()` for the banner on every page, and a Log line every tenth of the way.
 */
const EVERY_MS = 5_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const PRUNED_AT = 'pruned_at';
/** A backlog this big is long work: it is shown. Smaller ones are a few seconds' batches. */
const SHOWN_FROM = 5_000;
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

/** Logs a line each time `done` passes another tenth of `total`. */
function tenths(what: string, total: number): (done: number) => void {
	let shown = 0;
	return (done) => {
		const tenth = Math.floor((done / Math.max(1, total)) * 10);
		if (tenth > shown && tenth < 10) {
			shown = tenth;
			serverLog('info', 'search-index', progressLine(what, done, total));
		}
	};
}

export type SearchIndexKeeper = {
	stop: () => Promise<void>;
	progress: () => IndexingProgress | null;
};

export function startSearchIndex(db: Queryable, now: () => number = Date.now): SearchIndexKeeper {
	const state: {
		stopping: boolean;
		running: Promise<void>;
		timer: NodeJS.Timeout | null;
		progress: IndexingProgress | null;
	} = { stopping: false, running: Promise.resolve(), timer: null, progress: null };
	const startedAt = now();
	let waitLogged = false;

	const stopped = (): boolean => state.stopping;

	const buildHeaders = async (): Promise<void> => {
		const top =
			db.get<{ top: number | null }>(sql`select max(rowid) as top from messages`).top ?? 0;
		const long = top - headersCursor(db) > SHOWN_FROM;
		const total = long ? db.get<{ n: number }>(sql`select count(*) as n from messages`).n : 0;
		let done = long ? db.get<{ n: number }>(sql`select count(*) as n from content_docs`).n : 0;
		const report = tenths('Search index', total);
		if (long) {
			serverLog('info', 'search-index', progressLine('Building the search index', done, total));
		}
		const started = now();
		for (;;) {
			if (stopped()) return;
			const batch = indexNewHeaders(db);
			if (batch === 0) break;
			if (long) {
				done = Math.min(total, done + batch);
				state.progress = { stage: 'search-index', done, total };
				report(done);
			}
			await nextTurn();
		}
		if (state.progress?.stage === 'search-index') state.progress = null;
		if (long) {
			serverLog(
				'info',
				'search-index',
				`Search index built: ${String(total)} messages in ${String(Math.round((now() - started) / 1000))} s`
			);
		}
	};

	/** Returns whether the move is still to come (it waits for the update to settle). */
	const moveContent = async (): Promise<boolean> => {
		if (!legacyContentLeft(db)) {
			// An empty old table (a new install, or a move that finished) is simply dropped.
			if (hasLegacyContent(db)) moveLegacyContent(db);
			return false;
		}
		if (now() - startedAt < MOVE_AFTER_MS) {
			if (!waitLogged) {
				waitLogged = true;
				serverLog(
					'info',
					'search-index',
					"The AI tools' text index moves to lookstow-content.db 10 minutes after the start, once an update can no longer be rolled back"
				);
			}
			state.progress = { stage: 'content-waiting' };
			return true;
		}
		const total = db.get<{ n: number }>(sql`select count(*) as n from main.message_content`).n;
		const report = tenths("Moving the AI tools' text index", total);
		serverLog('info', 'search-index', progressLine("Moving the AI tools' text index", 0, total));
		let done = 0;
		for (;;) {
			if (stopped()) return false;
			const batch = moveLegacyContent(db);
			if (batch === null) break;
			done += batch;
			state.progress = { stage: 'content-moving', done, total };
			report(done);
			await nextTurn();
		}
		state.progress = null;
		serverLog(
			'info',
			'search-index',
			`Moved the AI tools' text index (${String(done)} messages) to lookstow-content.db`
		);
		return false;
	};

	const catchUp = async (): Promise<void> => {
		await buildHeaders();
		if (stopped()) return;
		const moveToCome = await moveContent();
		if (stopped() || moveToCome) return;
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
		progress: () => state.progress,
		stop: async () => {
			state.stopping = true;
			if (state.timer !== null) clearTimeout(state.timer);
			await state.running;
		}
	};
}
