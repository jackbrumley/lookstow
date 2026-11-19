import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	keepBusy,
	MICROSOFT,
	SimulatedMicrosoft,
	VirtualClock
} from '#tests/support/simulated-microsoft.ts';
import { EXPORT_PARALLEL, exportBatches } from '../engine/export-batches.ts';
import { writeMessageStream } from '../storage/eml-store.ts';
import { forEachLimited } from './discovery.ts';
import { Governor, LANE, PACE } from './governor.ts';

/**
 * The acceptance tests of docs/specs/SPEC-THROUGHPUT.md section 6, run against a simulated
 * Microsoft on a virtual clock (tests/support/simulated-microsoft.ts). Criteria 1, 8 and 9 are
 * in governor.test.ts and monitor.test.ts, 6 and 10 in the mailbox and archive sync tests.
 */
const MINUTE = 60_000;

function governorOn(clock: VirtualClock, startsPerSecond: number, inFlightCap = 32): Governor {
	return new Governor({
		now: () => clock.now,
		schedule: clock.schedule,
		learned: { startsPerSecond, inFlightCap, ceiling: null }
	});
}

/** App throttles more than 15 seconds apart are separate bursts; one burst is one cut. */
function bursts(times: readonly number[]): number[] {
	const starts: number[] = [];
	for (const at of times) {
		const last = starts.at(-1);
		if (last === undefined || at - last > 15_000) starts.push(at);
	}
	return starts;
}

describe('against a simulated app limit, with 20 mailboxes', () => {
	const LIMIT = 40;
	const MINUTES = 45;
	const names = Array.from({ length: 20 }, (_, index) => `mailbox-${String(index + 1)}`);
	const clock = new VirtualClock();
	// Lanes may go to their ceiling here, so only the app limit is under test.
	const microsoft = new SimulatedMicrosoft(clock, {
		...MICROSOFT,
		appLimitPerSecond: LIMIT,
		perMailbox: LANE.ceiling
	});
	const governor = governorOn(clock, LIMIT * 0.8);

	beforeAll(async () => {
		for (const name of names) {
			void keepBusy(
				governor,
				microsoft,
				name,
				LANE.ceiling + 2,
				() => clock.now >= MINUTES * MINUTE
			);
		}
		await clock.runUntil(MINUTES * MINUTE);
	}, 120_000);

	it('2: climbs, is cut once per burst, holds 30 minutes, and never cascades', () => {
		const cuts = bursts(microsoft.appThrottledAt);
		expect(cuts.length).toBeGreaterThanOrEqual(1);
		expect(cuts.length).toBeLessThanOrEqual(2);
		const [first = 0, second] = cuts;
		if (second !== undefined) expect(second - first).toBeGreaterThanOrEqual(PACE.holdMs);
		// While held, it copies just under the limit: not cut again, not cut too far.
		const from = Math.ceil(first / MINUTE) + 1;
		const held = microsoft.ratePerSecond(from, from + 25);
		expect(held).toBeGreaterThanOrEqual(LIMIT * (PACE.settle - 0.05));
		expect(held).toBeLessThanOrEqual(LIMIT);
	});

	it('4: after the climb, copies at least 90% of the limit and starves no mailbox', () => {
		expect(microsoft.ratePerSecond(10, MINUTES)).toBeGreaterThanOrEqual(LIMIT * 0.9);
		const counts = names.map((name) => microsoft.done.get(name) ?? 0);
		const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
		expect(Math.min(...counts)).toBeGreaterThanOrEqual(mean * 0.9);
	});
});

describe('a mailbox Microsoft keeps refusing', () => {
	it('3: its throttled waits free their permits for other mailboxes', async () => {
		const clock = new VirtualClock();
		const microsoft = new SimulatedMicrosoft(clock, {
			...MICROSOFT,
			perMailboxFor: { stuck: 0 }
		});
		// As few permits as the governor allows: if waits held them, "free" would get none.
		const governor = governorOn(clock, PACE.rateCeiling, PACE.inFlightFloor);
		const stop = () => clock.now >= MINUTE;
		void keepBusy(governor, microsoft, 'stuck', 8, stop);
		void keepBusy(governor, microsoft, 'free', 8, stop);
		await clock.runUntil(MINUTE);
		// One mailbox's best: its lane full, within its own budget of starts a second.
		const best = Math.min(LANE.start / (MICROSOFT.latencyMs / 1000), LANE.startsPerSecond) * 60;
		expect(microsoft.done.get('stuck') ?? 0).toBe(0);
		expect(microsoft.done.get('free')).toBeGreaterThanOrEqual(best * 0.9);
	});
});

describe('an archive with 200 items', () => {
	it('5: exports with its lane full, 4 batches in flight', async () => {
		const clock = new VirtualClock();
		const microsoft = new SimulatedMicrosoft(clock, MICROSOFT);
		const governor = governorOn(clock, PACE.rateCeiling, PACE.inFlightCeiling);
		const batches = exportBatches(
			Array.from({ length: 200 }, (_, index) => ({ id: `i${String(index)}`, size: 50_000 }))
		);
		expect(batches.length).toBeGreaterThan(LANE.start);
		let exported = 0;
		const done = forEachLimited(batches, EXPORT_PARALLEL, async (batch) => {
			const permit = await governor.acquire('mbx:archive');
			permit.release(await microsoft.call('mbx:archive'));
			exported += batch.ids.length;
		});
		await clock.runUntil(MINUTE);
		await done;
		expect(exported).toBe(200);
		expect(microsoft.peakInFlight.get('mbx:archive')).toBe(LANE.start);
		expect(microsoft.throttledMailbox).toBe(0);
	});
});

describe('a 150 MB message', () => {
	it('7: is written with less than 16 MB of memory for it, and its SHA-256 matches', async () => {
		const folder = await mkdtemp(join(tmpdir(), 'lookstow-big-'));
		const chunk = new Uint8Array(1024 * 1024).map((_, index) => index % 251);
		const chunks = 150;
		const expected = createHash('sha256');
		for (let index = 0; index < chunks; index++) expected.update(chunk);
		const baseline = process.memoryUsage().arrayBuffers;
		let peak = 0;
		let sent = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
					if (sent === chunks) {
						controller.close();
						return;
					}
					sent += 1;
					// The same buffer each time: only what the writer holds on to can grow.
					controller.enqueue(chunk);
				}
			},
			{ highWaterMark: 0 }
		);
		const path = join(folder, 'big.eml');
		const stored = await writeMessageStream(path, body);
		expect(stored.byteCount).toBe(chunks * chunk.length);
		expect(stored.sha256).toBe(expected.digest('hex'));
		expect(peak).toBeLessThan(16 * 1024 * 1024);
		expect(
			createHash('sha256')
				.update(await readFile(path))
				.digest('hex')
		).toBe(stored.sha256);
	}, 60_000);
});
