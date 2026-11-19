import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Queryable } from '../../database/connection.ts';
import { errorText, serverLog } from '../../log.ts';
import type { GovernorSnapshot } from '../../../domain/throughput.ts';
import { startSharedGovernor, type Governor } from '../graph/governor.ts';
import { readLearnedPace, saveLearnedPace } from '../settings/settings.ts';

/**
 * The throughput governor's life in the running service (docs/specs/SPEC-THROUGHPUT.md 4.5 and
 * 4.7): it starts from the pace learned before the last restart, saves what it learns every five
 * minutes and at shutdown, and writes a sample of its numbers every 10 seconds to a pace history
 * (one JSON line per sample, one file a day, seven days kept) for reading after a long run.
 * Nothing it writes names a mailbox, a person or a message: lanes are numbers.
 */
const SAVE_EVERY_MS = 5 * 60_000;
const SAMPLE_EVERY_MS = 10_000;
const HISTORY_DAYS = 7;
export const HISTORY_FOLDER = 'throughput';

/** Extra numbers the service adds to each sample (the engine's view, memory). */
export type SampleExtras = () => Record<string, unknown>;

export type ThroughputMonitor = { governor: Governor; stop: () => Promise<void> };

export function startThroughputMonitor(
	db: Queryable,
	dataDir: string,
	extras: SampleExtras,
	now: () => number = Date.now
): ThroughputMonitor {
	const governor = startSharedGovernor(readLearnedPace(db));
	const save = (): void => {
		try {
			saveLearnedPace(db, governor.learned(), now());
		} catch (error) {
			serverLog('warn', 'throughput', `Could not save the learned pace: ${errorText(error)}`);
		}
	};
	const folder = join(dataDir, HISTORY_FOLDER);
	let writing: Promise<void> = Promise.resolve();
	const sample = (): void => {
		const at = now();
		const line = `${JSON.stringify(historyLine(governor.snapshot(), extras(), at))}\n`;
		writing = writing
			.then(async () => {
				await mkdir(folder, { recursive: true });
				await appendFile(join(folder, historyFileName(at)), line, { mode: 0o600 });
			})
			.catch((error: unknown) => {
				serverLog('warn', 'throughput', `Could not write the pace history: ${errorText(error)}`);
			});
	};
	const prune = (): void => {
		writing = writing.then(() => pruneHistory(folder, now()));
	};
	const saving = setInterval(save, SAVE_EVERY_MS);
	const sampling = setInterval(sample, SAMPLE_EVERY_MS);
	const pruning = setInterval(prune, 6 * 60 * 60_000);
	for (const timer of [saving, sampling, pruning]) timer.unref();
	prune();
	return {
		governor,
		stop: async () => {
			for (const timer of [saving, sampling, pruning]) clearInterval(timer);
			save();
			sample();
			await writing;
		}
	};
}

export function historyFileName(at: number): string {
	return `${new Date(at).toISOString().slice(0, 10)}.jsonl`;
}

/** One sample: the governor's numbers without its change list, plus the service's extras. */
export function historyLine(
	snapshot: GovernorSnapshot,
	extras: Record<string, unknown>,
	at: number
): Record<string, unknown> {
	return {
		at: new Date(at).toISOString(),
		pace: snapshot.pace,
		rates: snapshot.rates,
		lanes: snapshot.lanes,
		...extras
	};
}

/** Deletes history files older than HISTORY_DAYS (by the date in their name). */
export async function pruneHistory(folder: string, now: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(folder);
	} catch {
		return;
	}
	const oldest = historyFileName(now - HISTORY_DAYS * 24 * 60 * 60_000);
	for (const name of names) {
		if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name < oldest) {
			await rm(join(folder, name), { force: true });
		}
	}
}
