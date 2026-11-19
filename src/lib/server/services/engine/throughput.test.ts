import { describe, expect, it } from 'vitest';
import { MailboxSlots, Throughput } from './throughput.ts';

const MINUTE = 60_000;

describe('throughput', () => {
	it('averages what was stored over the window asked for', () => {
		const meter = new Throughput();
		meter.record(0, { bytes: 60_000, messages: 6 });
		meter.record(30_000, { bytes: 60_000, messages: 6, throttled: 1 });
		expect(meter.rates(59_000, MINUTE)).toEqual({
			bytesPerSecond: 2000,
			messagesPerSecond: 0.2,
			throttled: 1
		});
		expect(meter.rates(80_000, MINUTE).bytesPerSecond).toBe(1000);
	});

	it('forgets what is older than 15 minutes', () => {
		const meter = new Throughput();
		meter.record(0, { bytes: 1000 });
		expect(meter.rates(16 * MINUTE, 15 * MINUTE).bytesPerSecond).toBe(0);
	});
});

describe('mailboxes at once', () => {
	const busy = { maximum: 32, headroom: true, waiting: 10 };

	it('adds a mailbox every 10 seconds while all slots are busy, work waits and the governor has room', () => {
		const slots = new MailboxSlots(0);
		expect(slots.adjust({ ...busy, running: 3, now: 5_000 })).toBe(3);
		expect(slots.adjust({ ...busy, running: 3, now: 10_000 })).toBe(4);
		expect(slots.adjust({ ...busy, running: 4, now: 15_000 })).toBe(4);
		expect(slots.adjust({ ...busy, running: 4, now: 20_000 })).toBe(5);
		// A free slot or no work waiting: no growth.
		expect(slots.adjust({ ...busy, running: 3, now: 40_000 })).toBe(5);
		expect(slots.adjust({ ...busy, waiting: 0, running: 5, now: 60_000 })).toBe(5);
	});

	it('shrinks to the mailboxes running while the governor has no headroom', () => {
		const slots = new MailboxSlots(0);
		for (let at = 10_000; at <= 100_000; at += 10_000) {
			slots.adjust({ ...busy, running: 32, now: at });
		}
		expect(slots.adjust({ ...busy, running: 32, now: 110_000 })).toBe(14);
		expect(slots.adjust({ ...busy, headroom: false, running: 7, now: 111_000 })).toBe(7);
		expect(slots.adjust({ ...busy, headroom: false, running: 0, now: 112_000 })).toBe(1);
	});

	it('never goes above the maximum', () => {
		const slots = new MailboxSlots(0);
		expect(slots.adjust({ ...busy, maximum: 2, running: 0, now: 1 })).toBe(2);
	});
});
