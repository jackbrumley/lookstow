import { monitorEventLoopDelay } from 'node:perf_hooks';
import { serverLog } from '../log.ts';

/**
 * How long a thread could not answer (docs/specs/SPEC-SCALE.md): Node measures how late its
 * timers run, which is how long something held the thread. Measured per minute; a minute whose
 * longest hold passed HELD_WARN_MS is logged.
 */
export type ThreadHealth = {
	/** The longest hold in the last full minute, in ms. */
	longestMs: number;
	/** 99% of that minute's moments waited less than this, in ms. */
	p99Ms: number;
	at: string | null;
};

const MINUTE_MS = 60_000;
const HELD_WARN_MS = 1_000;

let latest: ThreadHealth = { longestMs: 0, p99Ms: 0, at: null };

export function threadHealth(): ThreadHealth {
	return latest;
}

/** Starts measuring this thread; `name` is how the log names it ("web" or "work"). */
export function watchThread(name: string): () => void {
	const delay = monitorEventLoopDelay({ resolution: 20 });
	delay.enable();
	const timer = setInterval(() => {
		latest = {
			longestMs: Math.round(delay.max / 1e6),
			p99Ms: Math.round(delay.percentile(99) / 1e6),
			at: new Date().toISOString()
		};
		delay.reset();
		if (latest.longestMs >= HELD_WARN_MS) {
			serverLog(
				'warn',
				'slow-thread',
				`The ${name} thread was held for ${String(latest.longestMs)} ms in the last minute (most waits under ${String(latest.p99Ms)} ms)`
			);
		}
	}, MINUTE_MS);
	timer.unref();
	return () => {
		clearInterval(timer);
		delay.disable();
	};
}
