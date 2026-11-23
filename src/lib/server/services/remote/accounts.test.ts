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
import { openDatabase } from '../../database/connection.ts';
import { generatePassword, readAllowList } from './manage.ts';

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

describe('a password Lookstow makes', () => {
	it('is four groups of five letters and digits that cannot be confused, new each time', () => {
		const made = Array.from({ length: 200 }, () => generatePassword());
		for (const password of made) {
			expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{5}(-[a-km-zA-HJ-NP-Z2-9]{5}){3}$/);
			expect(password).not.toMatch(/[01lIoO]/);
		}
		expect(new Set(made).size).toBe(made.length);
	});
});

describe('sessions', () => {
	const HOUR = 3_600_000;

	it('last 7 days, or until 48 hours unused, and survive a restart', () => {
		const start = 1_000_000;
		const db = openDatabase(':memory:');
		const token = newSession(db, 'ann', start);
		expect(sessionUser(db, token, start + 47 * HOUR)).toBe('ann');
		expect(sessionUser(db, token, start + 94 * HOUR)).toBe('ann');
		expect(sessionUser(db, token, start + 94 * HOUR + 48 * HOUR)).toBeNull();

		// Used every day, it still ends after 7 days.
		const daily = newSession(db, 'ann', start);
		for (let day = 1; day < 7; day += 1) {
			expect(sessionUser(db, daily, start + day * 24 * HOUR)).toBe('ann');
		}
		expect(sessionUser(db, daily, start + 7 * 24 * HOUR)).toBeNull();
	});

	it('are kept only as a hash, and end at sign-out or for everyone of an account', () => {
		const start = 1_000_000;
		const db = openDatabase(':memory:');
		const out = newSession(db, 'bob', start);
		expect(JSON.stringify(db.$client.prepare('select * from remote_sessions').all())).not.toContain(
			out
		);
		endSession(db, out);
		expect(sessionUser(db, out, start)).toBeNull();

		const one = newSession(db, 'cat', start);
		const two = newSession(db, 'cat', start);
		endSessionsOf(db, 'cat');
		expect(sessionUser(db, one, start)).toBeNull();
		expect(sessionUser(db, two, start)).toBeNull();
		expect(sessionUser(db, undefined, start)).toBeNull();
		expect(sessionUser(db, 'made-up', start)).toBeNull();
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
