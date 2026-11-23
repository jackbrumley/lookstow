import { describe, expect, it } from 'vitest';
import {
	messageIdsIn,
	packExpired,
	packName,
	packNow,
	PACK_STALE_MS,
	zipSafeName,
	type EvidencePack
} from './evidence-packs.ts';

const A = '8dbe942e-57e6-4892-aa9a-193d9e1aaa4b';
const B = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function pack(changes: Partial<EvidencePack>): EvidencePack {
	return {
		id: A,
		name: 'Pack',
		createdBy: 'console',
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		status: 'building',
		withAttachments: false,
		total: 1,
		done: 0,
		sourceBytes: 1,
		missing: [],
		mismatched: 0,
		unreadable: 0,
		zipBytes: null,
		sha256: null,
		finishedAt: null,
		expiresAt: null,
		problem: null,
		...changes
	};
}

describe('pasted message ids', () => {
	it('are found in links, columns and text, once each, in the order first seen', () => {
		const pasted = `id\n${B}\nhttps://server:8443/messages/${A.toUpperCase()}\n"${B}", other text ${A}`;
		expect(messageIdsIn(pasted)).toEqual({ ids: [B, A], repeats: 2 });
		expect(messageIdsIn('nothing here 1234')).toEqual({ ids: [], repeats: 0 });
	});
});

describe('a pack', () => {
	it('is named as typed, made safe, or after the day', () => {
		const now = new Date('2026-11-23T10:00:00Z');
		expect(packName('  Timesheets 2023, for counsel ', now)).toBe('Timesheets 2023, for counsel');
		expect(packName('a/b\\c:d*?', now)).toBe('a b c d');
		expect(packName('', now)).toBe('Evidence pack 2026-11-23');
	});

	it('left building by a stopped service has failed; one still moving has not', () => {
		const moving = pack({ updatedAt: new Date(1000).toISOString() });
		expect(packNow(moving, 1000 + PACK_STALE_MS - 1).status).toBe('building');
		expect(packNow(moving, 1000 + PACK_STALE_MS)).toMatchObject({ status: 'failed' });
		expect(packNow(pack({ status: 'ready' }), PACK_STALE_MS * 10).status).toBe('ready');
	});

	it('expires once past its keeping time', () => {
		expect(packExpired(pack({ expiresAt: null }), 10)).toBe(false);
		expect(packExpired(pack({ expiresAt: new Date(10).toISOString() }), 9)).toBe(false);
		expect(packExpired(pack({ expiresAt: new Date(10).toISOString() }), 10)).toBe(true);
	});

	it('names files the way Windows accepts', () => {
		expect(zipSafeName('Re: pay? <urgent> "now" | a/b\\c*', 100)).toBe('Re pay urgent now a b c');
		expect(zipSafeName('trailing dots...  ', 100)).toBe('trailing dots');
		expect(zipSafeName('   ', 100)).toBe('(none)');
		expect(zipSafeName('x'.repeat(200), 60)).toHaveLength(60);
	});
});
