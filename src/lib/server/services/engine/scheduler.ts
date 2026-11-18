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
 */
export type Candidate = {
	id: string;
	firstCopyDone: boolean;
	/** ms since 1970, or null when it has never synced. */
	lastSyncStartedAt: number | null;
	lastSyncFinishedAt: number | null;
};

export type SchedulePlan = {
	/** Mailboxes to start now, in order. */
	start: string[];
	/** For the dashboard: mailboxes waiting in each queue (not counting those started now). */
	waiting: { requested: number; due: number; firstCopy: number };
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
	const isRequested = (candidate: Candidate) =>
		requested.has(candidate.id) ||
		(allRequestedAt !== null && (candidate.lastSyncStartedAt ?? 0) < allRequestedAt);
	const asked = idle.filter(isRequested);
	const due = idle
		.filter(
			(candidate) =>
				!isRequested(candidate) &&
				candidate.firstCopyDone &&
				now - (candidate.lastSyncFinishedAt ?? 0) >= intervalMs
		)
		.sort((a, b) => (a.lastSyncFinishedAt ?? 0) - (b.lastSyncFinishedAt ?? 0));
	const firstCopies = idle
		.filter((candidate) => !isRequested(candidate) && !candidate.firstCopyDone)
		// A first copy that stopped part-way (paused, failed) waits its interval like any other.
		.filter(
			(candidate) =>
				candidate.lastSyncFinishedAt === null || now - candidate.lastSyncFinishedAt >= intervalMs
		)
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
	return {
		start,
		waiting: {
			requested: asked.filter((candidate) => !started.has(candidate.id)).length,
			due: due.filter((candidate) => !started.has(candidate.id)).length,
			firstCopy: firstCopies.filter((candidate) => !started.has(candidate.id)).length
		}
	};
}
