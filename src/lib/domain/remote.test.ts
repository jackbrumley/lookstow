import { describe, expect, it } from 'vitest';
import {
	allowed,
	openWithoutSignIn,
	parseAllowEntry,
	remoteMayOpen,
	validUsername,
	type AllowEntry
} from './remote.ts';

function list(...lines: string[]): AllowEntry[] {
	return lines.map(parseAllowEntry).filter((entry): entry is AllowEntry => entry !== null);
}

describe('the allow-list', () => {
	it('reads addresses and IPv4 ranges, and refuses anything else', () => {
		expect(parseAllowEntry('10.1.2.3')).toEqual({ kind: 'v4', base: 167838211, bits: 32 });
		expect(parseAllowEntry(' 10.1.2.0/24 ')).toMatchObject({ kind: 'v4', bits: 24 });
		expect(parseAllowEntry('fe80::1')).toEqual({ kind: 'v6', address: 'fe80::1' });
		for (const wrong of ['', '10.1.2', '10.1.2.256', '10.1.2.0/7', '10.1.2.0/33', 'host', '0/0']) {
			expect(parseAllowEntry(wrong)).toBeNull();
		}
	});

	it('lets in only listed addresses and ranges, however Node writes IPv4', () => {
		const entries = list('10.1.2.3', '192.168.5.0/24', 'fe80::1');
		expect(allowed('10.1.2.3', entries)).toBe(true);
		expect(allowed('::ffff:10.1.2.3', entries)).toBe(true);
		expect(allowed('10.1.2.4', entries)).toBe(false);
		expect(allowed('192.168.5.200', entries)).toBe(true);
		expect(allowed('192.168.6.1', entries)).toBe(false);
		expect(allowed('FE80::1', entries)).toBe(true);
		expect(allowed('fe80::2', entries)).toBe(false);
		expect(allowed('10.1.2.3', [])).toBe(false);
	});
});

describe('what a remote person may open', () => {
	it('reads the dashboard, mailboxes, search and messages, and nothing else', () => {
		for (const path of [
			'/',
			'/__data.json',
			'/mailboxes',
			'/mailboxes/abc',
			'/mailboxes/abc/__data.json',
			'/search',
			'/messages/42',
			'/messages/42/attachments/1/open',
			'/how-it-works',
			'/_app/immutable/start.js'
		]) {
			expect(remoteMayOpen('GET', path), path).toBe(true);
		}
		for (const path of [
			'/settings',
			'/log',
			'/updates',
			'/alerts',
			'/activity',
			'/mcp',
			'/control'
		]) {
			expect(remoteMayOpen('GET', path), path).toBe(false);
		}
		expect(remoteMayOpen('HEAD', '/messages/42')).toBe(true);
	});

	it('changes nothing: the only write is signing out', () => {
		expect(remoteMayOpen('POST', '/signout')).toBe(true);
		expect(remoteMayOpen('POST', '/')).toBe(false);
		expect(remoteMayOpen('POST', '/mailboxes/abc')).toBe(false);
		expect(remoteMayOpen('POST', '/settings')).toBe(false);
		expect(remoteMayOpen('PUT', '/messages/42')).toBe(false);
		expect(remoteMayOpen('DELETE', '/messages/42')).toBe(false);
	});

	it('shows only the sign-in page and the app files before signing in', () => {
		expect(openWithoutSignIn('/signin')).toBe(true);
		expect(openWithoutSignIn('/_app/immutable/start.js')).toBe(true);
		expect(openWithoutSignIn('/')).toBe(false);
		expect(openWithoutSignIn('/messages/42')).toBe(false);
		expect(openWithoutSignIn('/signin/__data.json')).toBe(false);
	});

	it('takes plain account names', () => {
		expect(validUsername('ann.smith')).toBe(true);
		expect(validUsername('a')).toBe(false);
		expect(validUsername('ann smith')).toBe(false);
		expect(validUsername('ann@example.com')).toBe(false);
	});
});
