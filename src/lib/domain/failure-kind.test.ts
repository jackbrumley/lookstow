import { describe, expect, it } from 'vitest';
import { failureKind, failureSummary } from './failure-kind.ts';

describe('kinds of failure', () => {
	it('sorts error text into a few kinds', () => {
		expect(failureKind('Graph answered 429 TooManyRequests')).toBe('throttled');
		expect(
			failureKind(
				'Microsoft refused access to the online archive (403 ErrorAccessDenied: Access is denied.)'
			)
		).toBe('permission');
		expect(failureKind('AADSTS7000215: Invalid client secret provided.')).toBe('permission');
		expect(failureKind('ENOSPC: no space left on device, write')).toBe('disk');
		expect(failureKind('fetch failed (ECONNRESET)')).toBe('network');
		// Seen on Sarah Croft's archive: a broken reply is the network, not a Microsoft error.
		expect(
			failureKind("Microsoft Graph's reply broke off 3 times in a row (terminated) (terminated)")
		).toBe('network');
		expect(failureKind('Graph answered 503 ServiceUnavailable')).toBe('microsoft');
		expect(failureKind('Something odd')).toBe('other');
	});

	it('summarises the kinds, most common first', () => {
		expect(failureSummary({ network: 1, permission: 2, disk: 0 })).toBe('2 permission, 1 network');
		expect(failureSummary({})).toBe('');
	});
});
