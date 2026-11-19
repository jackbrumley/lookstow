/**
 * Runs the throughput governor against a simulated Microsoft 365 on a virtual clock and prints
 * what it achieved (docs/specs/SPEC-THROUGHPUT.md 6): requests a second minute by minute, the
 * share of the app limit, each pace change, and how evenly the mailboxes were served.
 *
 *   node scripts/throughput-bench.ts [mailboxes=20] [limit=100] [minutes=60] [startRate=20]
 *
 * Nothing here touches the network or a real tenant.
 */
import { Governor } from '#lib/server/services/graph/governor.ts';
import {
	keepBusy,
	MICROSOFT,
	SimulatedMicrosoft,
	VirtualClock
} from '#tests/support/simulated-microsoft.ts';

const [mailboxes = 20, limit = 100, minutes = 60, startRate = 20] = process.argv
	.slice(2)
	.map((value) => Number.parseFloat(value));

const clock = new VirtualClock();
const governor = new Governor({
	now: () => clock.now,
	schedule: clock.schedule,
	learned: { startsPerSecond: startRate, inFlightCap: 32, ceiling: null }
});
const microsoft = new SimulatedMicrosoft(clock, { ...MICROSOFT, appLimitPerSecond: limit });
const end = minutes * 60_000;
const names = Array.from({ length: mailboxes }, (_, index) => `mailbox-${String(index + 1)}`);
for (const name of names) {
	void keepBusy(governor, microsoft, name, 6, () => clock.now >= end);
}
const started = performance.now();
await clock.runUntil(end);
const tookMs = performance.now() - started;

console.log(
	`${String(mailboxes)} mailboxes, app limit ${String(limit)}/s, ${String(minutes)} min simulated in ${(tookMs / 1000).toFixed(1)} s`
);
for (let minute = 0; minute < minutes; minute += 5) {
	const rate = microsoft.ratePerSecond(minute, Math.min(minutes, minute + 5));
	console.log(
		`  min ${String(minute).padStart(3)}–${String(minute + 5).padEnd(3)} ${rate.toFixed(1).padStart(6)}/s  ${((rate / limit) * 100).toFixed(0).padStart(3)}% of the limit`
	);
}
const settled = microsoft.ratePerSecond(Math.floor(minutes / 2), minutes);
const counts = names.map((name) => microsoft.done.get(name) ?? 0);
const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
console.log(
	`Second half: ${settled.toFixed(1)}/s (${((settled / limit) * 100).toFixed(1)}% of the limit)`
);
console.log(
	`Throttled: ${String(microsoft.throttledApp)} app, ${String(microsoft.throttledMailbox)} mailbox`
);
console.log(
	`Fairness: least-served mailbox got ${((Math.min(...counts) / mean) * 100).toFixed(0)}% of the mean`
);
console.log('Pace changes:');
for (const change of governor.snapshot().changes) {
	console.log(`  ${change.at.slice(11, 19)} ${change.from} -> ${change.to}: ${change.reason}`);
}
process.exit(0);
