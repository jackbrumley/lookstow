import { afterEach, describe, expect, it } from 'vitest';
import { formatDateTime, formatTimeOfDay, setDisplayTimeZone } from './format.ts';

describe('times', () => {
	afterEach(() => {
		setDisplayTimeZone('UTC');
	});

	it('show in the server’s zone, whatever zone the time was written in', () => {
		setDisplayTimeZone('Australia/Brisbane');
		// A message sent at 22:59 UTC: 8:59 the next morning in Brisbane.
		expect(formatDateTime('2020-07-08T22:59:15Z')).toBe('9 July 2020, 8:59 am');
		expect(formatDateTime('2020-07-08T22:59:15Z', true)).toBe('9 July 2020, 8:59 am AEST');
		expect(formatTimeOfDay('2020-07-08T22:59:15Z')).toBe('8:59:15 am');
		expect(formatDateTime(null)).toBe('never');
	});
});
