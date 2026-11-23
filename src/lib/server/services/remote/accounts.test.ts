import { describe, expect, it } from 'vitest';
import {
	clearStrikes,
	endSession,
	endSessionsOf,
	hashPassword,
	locked,
	newSession,
	passwordMatches,
	sessionUser,
	strike
} from './accounts.ts';
import { safeNext } from './sign-in.ts';
import { readAllowList } from './manage.ts';

describe('passwords', () => {
	it('keeps a salted hash that only the same password matches', async () => {
		const stored = await hashPassword('correct horse battery');
		expect(stored).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
		expect(stored).not.toContain('correct');
		expect(await passwordMatches('correct horse battery', stored)).toBe(true);
		expect(await passwordMatches('correct horse batterY', stored)).toBe(false);
		expect(await hashPassword('correct horse battery')).not.toBe(stored);
		expect(await passwordMatches('anything', 'not a hash')).toBe(false);
	});
});

describe('sessions', () => {
	it('end after 8 hours, an idle hour, a sign-out, or for everyone of an account', () => {
		const start = 1_000_000;
		const token = newSession('ann', start);
		expect(sessionUser(token, start + 59 * 60_000)).toBe('ann');
		expect(sessionUser(token, start + 59 * 60_000 * 2)).toBe('ann');
		expect(sessionUser(token, start + 59 * 60_000 * 2 + 3_600_000)).toBeNull();

		const long = newSession('ann', start);
		let now = start;
		for (let hour = 0; hour < 7; hour += 1) {
			now += 50 * 60_000;
			expect(sessionUser(long, now)).toBe('ann');
		}
		expect(sessionUser(long, start + 8 * 3_600_000)).toBeNull();

		const out = newSession('bob', start);
		endSession(out);
		expect(sessionUser(out, start)).toBeNull();

		const one = newSession('cat', start);
		const two = newSession('cat', start);
		endSessionsOf('cat');
		expect(sessionUser(one, start)).toBeNull();
		expect(sessionUser(two, start)).toBeNull();
		expect(sessionUser(undefined, start)).toBeNull();
		expect(sessionUser('made-up', start)).toBeNull();
	});
});

describe('lockout', () => {
	it('locks a name and address for 15 minutes after five wrong passwords', () => {
		const keys = ['user:dan', 'ip:10.0.0.9'];
		for (let attempt = 0; attempt < 4; attempt += 1) strike(keys, 0);
		expect(locked(keys, 0)).toBe(false);
		strike(keys, 0);
		expect(locked(['user:dan'], 1)).toBe(true);
		expect(locked(['ip:10.0.0.9'], 1)).toBe(true);
		expect(locked(['user:dan'], 15 * 60_000)).toBe(false);
		clearStrikes(keys);
		strike(keys, 0);
		expect(locked(keys, 1)).toBe(false);
		clearStrikes(keys);
	});
});

describe('signing in', () => {
	it('goes on only to a path on this site', () => {
		expect(safeNext('/messages/42')).toBe('/messages/42');
		expect(safeNext('/search?q=x')).toBe('/search?q=x');
		expect(safeNext(null)).toBe('/');
		expect(safeNext('https://elsewhere.example')).toBe('/');
		expect(safeNext('//elsewhere.example')).toBe('/');
		expect(safeNext('/' + String.fromCharCode(92) + 'elsewhere.example')).toBe('/');
	});
});

describe('the allow-list as typed', () => {
	it('takes one per line, commas or spaces, and names what it cannot read', () => {
		expect(readAllowList('10.1.2.3\n10.1.5.0/24, 10.1.2.3  fe80::1')).toEqual([
			'10.1.2.3',
			'10.1.5.0/24',
			'fe80::1'
		]);
		expect(readAllowList('')).toEqual([]);
		expect(() => readAllowList('10.1.2.3 server1')).toThrow(/server1/);
	});
});
