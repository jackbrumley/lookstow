import { describe, expect, it } from 'vitest';
import { AdaptiveSlots, Throughput } from './throughput.ts';

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

describe('adaptive slots', () => {
	it('adds a mailbox every two minutes while busy and not throttled, up to the maximum', () => {
		const slots = new AdaptiveSlots(2, 0);
		expect(slots.adjust(4, 0, true, MINUTE)).toBe(2);
		expect(slots.adjust(4, 0, true, 2 * MINUTE)).toBe(3);
		expect(slots.adjust(4, 0, true, 4 * MINUTE)).toBe(4);
		expect(slots.adjust(4, 0, true, 6 * MINUTE)).toBe(4);
	});

	it('halves when Graph throttles, but not more than once a minute', () => {
		const slots = new AdaptiveSlots(8, 0);
		expect(slots.adjust(8, 10, true, MINUTE)).toBe(4);
		expect(slots.adjust(8, 10, true, MINUTE + 10_000)).toBe(4);
		expect(slots.adjust(8, 10, true, 2 * MINUTE)).toBe(2);
	});

	it('never goes above a lowered maximum', () => {
		const slots = new AdaptiveSlots(8, 0);
		expect(slots.adjust(3, 0, true, 1)).toBe(3);
	});
});
