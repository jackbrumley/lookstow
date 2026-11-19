/**
 * Which mailboxes sync next. Each mailbox has its own timer: it is due when its last sync
 * finished more than the interval ago. Three queues share the parallel slots, in this order:
 *
 * 1. mailboxes someone asked for (Sync now, Sync all now, newly found or picked);
 * 2. mailboxes already copied once whose routine sync is due, oldest first;
 * 3. first copies, those never started first, then the longest waiting.
 *
 * First copies may take every slot but one (when there is more than one), so a mailbox
 * already backed up is never held up for days behind a 50 GB first copy.
 *
 * A mailbox whose last syncs failed waits a back-off instead of its interval: 30 seconds after
 * the first failure, doubling to at most 15 minutes, so a passing fault is retried soon and a
 * lasting one is not hammered (docs/specs/SPEC-THROUGHPUT.md 4.9.6).
 */
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MOST_MS = 15 * 60_000;

/** How long a mailbox waits after its latest failure, given how many failed in a row. */
export function failureBackoffMs(failuresInARow: number): number {
	const doublings = Math.min(Math.max(0, failuresInARow - 1), 10);
	return Math.min(BACKOFF_MOST_MS, BACKOFF_FIRST_MS * 2 ** doublings);
}

export type Candidate = {
	id: string;
	firstCopyDone: boolean;
	/** ms since 1970, or null when it has never synced. */
	lastSyncStartedAt: number | null;
	lastSyncFinishedAt: number | null;
	/** Syncs that failed in a row, most recent first; 0 (or absent) when the last one did not. */
	failuresInARow?: number;
};

export type SchedulePlan = {
	/** Mailboxes to start now, in order. */
	start: string[];
	/** For the dashboard: mailboxes waiting in each queue (not counting those started now). */
	waiting: {
		requested: number;
		due: number;
		firstCopy: number;
		/** Up to date (or recently stopped): waiting for their interval. */
		later: number;
		/** When the soonest of those is due (ms), or null. */
		nextDueAt: number | null;
	};
};

export function planSyncs(options: {
	candidates: readonly Candidate[];
	running: ReadonlySet<string>;
	requested: ReadonlySet<string>;
	/** Mailboxes due because Sync all now was pressed at this time (ms), or null. */
	allRequestedAt: number | null;
	now: number;
	intervalMs: number;
	slots: number;
}): SchedulePlan {
	const { candidates, running, requested, allRequestedAt, now, intervalMs, slots } = options;
	const idle = candidates.filter((candidate) => !running.has(candidate.id));
	const waitOf = (candidate: Candidate) => {
		const failures = candidate.failuresInARow ?? 0;
		return failures > 0 ? failureBackoffMs(failures) : intervalMs;
	};
	const rested = (candidate: Candidate) =>
		now - (candidate.lastSyncFinishedAt ?? 0) >= waitOf(candidate);
	const isRequested = (candidate: Candidate) =>
		requested.has(candidate.id) ||
		(allRequestedAt !== null && (candidate.lastSyncStartedAt ?? 0) < allRequestedAt);
	const asked = idle.filter(isRequested);
	const due = idle
		.filter((candidate) => !isRequested(candidate) && candidate.firstCopyDone && rested(candidate))
		.sort((a, b) => (a.lastSyncFinishedAt ?? 0) - (b.lastSyncFinishedAt ?? 0));
	const firstCopies = idle
		.filter((candidate) => !isRequested(candidate) && !candidate.firstCopyDone)
		// A first copy that stopped part-way (paused, failed) waits its interval like any other.
		.filter((candidate) => candidate.lastSyncFinishedAt === null || rested(candidate))
		.sort((a, b) => (a.lastSyncStartedAt ?? -1) - (b.lastSyncStartedAt ?? -1));

	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const firstCopyCap = slots > 1 ? slots - 1 : slots;
	let free = Math.max(0, slots - running.size);
	let firstCopiesRunning = [...running].filter(
		(id) => byId.get(id)?.firstCopyDone === false
	).length;
	const start: string[] = [];
	for (const candidate of [...asked, ...due, ...firstCopies]) {
		if (free === 0) {
			break;
		}
		const isFirstCopy = !candidate.firstCopyDone;
		// Requested mailboxes skip the cap: someone is waiting for them.
		if (isFirstCopy && !isRequested(candidate) && firstCopiesRunning >= firstCopyCap) {
			continue;
		}
		start.push(candidate.id);
		free -= 1;
		if (isFirstCopy) {
			firstCopiesRunning += 1;
		}
	}
	const started = new Set(start);
	const queued = new Set([...asked, ...due, ...firstCopies].map((candidate) => candidate.id));
	const later = idle.filter((candidate) => !queued.has(candidate.id));
	const nextDue = later
		.map((candidate) => (candidate.lastSyncFinishedAt ?? 0) + waitOf(candidate))
		.reduce<number | null>(
			(soonest, at) => (soonest === null || at < soonest ? at : soonest),
			null
		);
	return {
		start,
		waiting: {
			later: later.length,
			nextDueAt: nextDue,
			requested: asked.filter((candidate) => !started.has(candidate.id)).length,
			due: due.filter((candidate) => !started.has(candidate.id)).length,
			firstCopy: firstCopies.filter((candidate) => !started.has(candidate.id)).length
		}
	};
}
