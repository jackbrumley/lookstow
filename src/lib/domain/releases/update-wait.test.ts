import { describe, expect, it } from 'vitest';
import { updateWaitLine } from './update-wait.ts';

describe('the update countdown', () => {
	it('counts down the usual three minutes, then says it is taking longer', () => {
		expect(updateWaitLine(0)).toBe('About 3 minutes left');
		expect(updateWaitLine(-5)).toBe('About 3 minutes left');
		expect(updateWaitLine(30_000)).toBe('About 2 min 30 s left');
		expect(updateWaitLine(120_000)).toBe('About 1 minute left');
		expect(updateWaitLine(138_200)).toBe('About 42 seconds left');
		expect(updateWaitLine(179_000)).toBe('About 1 second left');
		expect(updateWaitLine(180_000)).toBe('Taking a little longer than usual');
		expect(updateWaitLine(600_000)).toBe('Taking a little longer than usual');
	});
});
