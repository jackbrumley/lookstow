import { describe, expect, it } from 'vitest';
import { Governor, LANE, PACE, laneOf, type Permit, type Schedule } from './governor.ts';

/** A clock and timers the test moves by hand. */
function manualTime(start = 1_000_000) {
	let now = start;
	const timers: { at: number; run: () => void }[] = [];
	const schedule: Schedule = (ms, run) => {
		const timer = { at: now + ms, run };
		timers.push(timer);
		return () => {
			const index = timers.indexOf(timer);
			if (index >= 0) timers.splice(index, 1);
		};
	};
	return {
		now: () => now,
		schedule,
		/** Moves time on, running every timer that falls due, in order. */
		advance(ms: number) {
			const until = now + ms;
			for (;;) {
				timers.sort((a, b) => a.at - b.at);
				const next = timers[0];
				if (next === undefined || next.at > until) break;
				timers.shift();
				now = next.at;
				next.run();
			}
			now = until;
		}
	};
}

/** Lets promise callbacks run. */
async function settle(): Promise<void> {
	for (let index = 0; index < 5; index++) await Promise.resolve();
}

function ok(permit: Permit, bytes = 1000): void {
	permit.release({ kind: 'ok', bytes, pressure: false });
}

describe('which mailbox a request is about', () => {
	it('finds the mailbox in user and export API URLs, and none for the rest', () => {
		expect(laneOf('https://graph.microsoft.com/v1.0/users/ABC/messages/x/$value')).toBe('abc');
		expect(
			laneOf('https://graph.microsoft.com/beta/admin/exchange/mailboxes/MBX:a@b/exportItems')
		).toBe('mbx:a@b');
		expect(laneOf('https://graph.microsoft.com/v1.0/users?$select=id')).toBe('');
	});
});

describe('the governor', () => {
	it('lets a mailbox have only its lane’s requests in flight', async () => {
		const time = manualTime();
		const governor = new Governor({ now: time.now, schedule: time.schedule });
		const started: Permit[] = [];
		for (let index = 0; index < 6; index++) {
			void governor.acquire('mbx-a').then((permit) => started.push(permit));
		}
		await settle();
		expect(started).toHaveLength(LANE.start);
		ok(started[0] ?? fail());
		await settle();
		expect(started).toHaveLength(LANE.start + 1);
	});

	it('serves mailboxes in turn, so one big mailbox does not starve another', async () => {
		const time = manualTime();
		const governor = new Governor({
			now: time.now,
			schedule: time.schedule,
			learned: { startsPerSecond: 2, inFlightCap: 100, ceiling: null }
		});
		// Use up this second's tokens, so the rest wait in the queue.
		await governor.acquire('warm-up');
		await governor.acquire('warm-up');
		const order: string[] = [];
		for (let index = 0; index < 4; index++)
			void governor.acquire('big').then(() => order.push('big'));
		void governor.acquire('small').then(() => order.push('small'));
		await settle();
		expect(order).toEqual([]);
		// The next two tokens go to each waiting mailbox in turn, not both to the big one.
		time.advance(1000);
		await settle();
		expect([...order].sort()).toEqual(['big', 'small']);
	});

	it('spends no more than its starts a second, then waits for the next token', async () => {
		const time = manualTime();
		const governor = new Governor({
			now: time.now,
			schedule: time.schedule,
			learned: { startsPerSecond: 4, inFlightCap: 100, ceiling: null }
		});
		const started: Permit[] = [];
		for (let index = 0; index < 8; index++) {
			void governor.acquire('').then((permit) => started.push(permit));
		}
		await settle();
		expect(started).toHaveLength(4);
		time.advance(500);
		await settle();
		expect(started).toHaveLength(6);
		time.advance(500);
		await settle();
		expect(started).toHaveLength(8);
	});

	it('lowers only the mailbox’s own lane when Microsoft says too many at once for it', async () => {
		const time = manualTime();
		const governor = new Governor({ now: time.now, schedule: time.schedule });
		const permit = await governor.acquire('mbx-a');
		permit.release({
			kind: 'throttled',
			scope: 'mailbox',
			retryAfterMs: 1000,
			code: 'MailboxConcurrency'
		});
		const snapshot = governor.snapshot();
		expect(snapshot.lanes[0]?.limit).toBe(LANE.start - 1);
		expect(snapshot.pace.startsPerSecond).toBe(PACE.startRate);
		expect(snapshot.pace.lastCut).toBeNull();
	});

	it('climbs while the pace holds work back, cuts once per burst to 85%, then holds', async () => {
		const time = manualTime();
		const governor = new Governor({
			now: time.now,
			schedule: time.schedule,
			learned: { startsPerSecond: 10, inFlightCap: PACE.inFlightFloor, ceiling: null }
		});
		// More work than the in-flight cap allows, one request per mailbox: the pace holds it.
		const started: Permit[] = [];
		for (let index = 0; index < PACE.inFlightFloor + 2; index++) {
			void governor.acquire(`m${String(index)}`).then((permit) => started.push(permit));
		}
		await settle();
		expect(started).toHaveLength(PACE.inFlightFloor);
		expect(governor.snapshot().pace.waitingForPace).toBe(2);
		time.advance(PACE.raiseEveryMs);
		ok(started[0] ?? fail());
		await settle();
		const climbed = governor.snapshot().pace;
		expect(climbed.startsPerSecond).toBeGreaterThan(10);
		expect(climbed.inFlightCap).toBeGreaterThan(PACE.inFlightFloor);
		expect(climbed.phase).toBe('climbing');
		for (const permit of started.slice(1)) ok(permit);
		await settle();

		const refused = climbed.startsPerSecond;
		const a = await governor.acquire('x');
		const b = await governor.acquire('y');
		a.release({
			kind: 'throttled',
			scope: 'app',
			retryAfterMs: 5000,
			code: 'ApplicationThrottled'
		});
		// The same burst: changes nothing more.
		b.release({
			kind: 'throttled',
			scope: 'app',
			retryAfterMs: 5000,
			code: 'ApplicationThrottled'
		});
		const cut = governor.snapshot().pace;
		expect(cut.startsPerSecond).toBeCloseTo(refused * PACE.settle, 1);
		expect(cut.phase).toBe('holding');
		expect(cut.lastCut?.code).toBe('ApplicationThrottled');
		expect(
			governor
				.snapshot()
				.changes.filter((change) => change.reason.startsWith('Microsoft throttled'))
		).toHaveLength(1);
		expect(governor.learned().ceiling?.startsPerSecond).toBeCloseTo(refused, 1);
	});

	it('starts from what it learned before, and forgets on request', () => {
		const time = manualTime();
		const governor = new Governor({
			now: time.now,
			schedule: time.schedule,
			learned: {
				startsPerSecond: 55,
				inFlightCap: 70,
				ceiling: { startsPerSecond: 64, inFlightCap: 80, at: 1 }
			}
		});
		expect(governor.snapshot().pace).toMatchObject({
			startsPerSecond: 55,
			inFlightCap: 70,
			phase: 'probing'
		});
		governor.forget();
		expect(governor.learned()).toEqual({
			startsPerSecond: PACE.startRate,
			inFlightCap: PACE.startInFlight,
			ceiling: null
		});
	});

	it('names mailboxes only by number, and counts requests, bytes and throttling', async () => {
		const time = manualTime();
		const governor = new Governor({ now: time.now, schedule: time.schedule });
		ok(await governor.acquire('secret-user-id'), 2048);
		const throttled = await governor.acquire('secret-user-id');
		throttled.release({
			kind: 'throttled',
			scope: 'mailbox',
			retryAfterMs: 1000,
			code: 'MailboxConcurrency'
		});
		const snapshot = governor.snapshot();
		expect(JSON.stringify(snapshot)).not.toContain('secret');
		expect(snapshot.lanes[0]?.name).toBe('mailbox-1');
		expect(snapshot.rates.lastMinute).toEqual({
			requests: 2,
			bytes: 2048,
			throttled: 1,
			failed: 0
		});
	});

	it('says when another mailbox would not help', async () => {
		const time = manualTime();
		const governor = new Governor({ now: time.now, schedule: time.schedule });
		expect(governor.headroom().more).toBe(true);
		const permit = await governor.acquire('a');
		permit.release({
			kind: 'throttled',
			scope: 'app',
			retryAfterMs: 1000,
			code: 'TooManyRequests'
		});
		expect(governor.headroom()).toEqual({
			more: false,
			reason: 'Microsoft asked Lookstow to slow down in the last minute'
		});
	});
});

function fail(): never {
	throw new Error('missing permit');
}
