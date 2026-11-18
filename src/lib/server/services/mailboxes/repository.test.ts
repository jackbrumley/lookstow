import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { inScope } from '../engine/scope.ts';
import { applyDiscovery, mailboxById } from './repository.ts';
import { SCOPE_DEFAULTS } from '../../../domain/settings.ts';

const ann = {
	userId: 'u1',
	kind: 'user',
	address: 'ann@example.com',
	displayName: 'Ann',
	exchangeMailboxId: null
};
const annArchive = {
	userId: 'u1',
	kind: 'archive',
	address: 'ann@example.com',
	displayName: 'Ann (archive)',
	exchangeMailboxId: 'a1'
};
const sales = {
	userId: 'u2',
	kind: 'shared',
	address: 'sales@example.com',
	displayName: 'Sales',
	exchangeMailboxId: null
};

describe('applying discovery', () => {
	it('adds new mailboxes and points archives at their primary', () => {
		const db = openDatabase(':memory:');
		const { added } = applyDiscovery(db, [annArchive, ann, sales], 1);
		expect(added.map((row) => row.kind).sort()).toEqual(['archive', 'shared', 'user']);
		const primary = added.find((row) => row.kind === 'user');
		expect(added.find((row) => row.kind === 'archive')?.primaryMailboxId).toBe(primary?.id);
	});

	it('marks a mailbox gone when it disappears, and back when it returns, keeping its row', () => {
		const db = openDatabase(':memory:');
		const first = applyDiscovery(db, [ann, sales], 1);
		const salesRow = first.added.find((row) => row.kind === 'shared');
		const second = applyDiscovery(db, [ann], 2);
		expect(second.gone.map((row) => row.address)).toEqual(['sales@example.com']);
		expect(mailboxById(db, salesRow?.id ?? '')?.goneAt).toEqual(new Date(2));
		const third = applyDiscovery(db, [ann, sales], 3);
		expect(third.added).toEqual([]);
		expect(third.returned.map((row) => row.address)).toEqual(['sales@example.com']);
		expect(mailboxById(db, salesRow?.id ?? '')?.goneAt).toBeNull();
	});
});

describe('scope', () => {
	it('backs up only the picked addresses in picked mode, whatever their kind', () => {
		const scope = {
			...SCOPE_DEFAULTS,
			mode: 'selected' as const,
			selectedAddresses: ['x@example.com']
		};
		const base = { excluded: false };
		expect(inScope({ ...base, kind: 'room', address: 'x@example.com' }, scope)).toBe(true);
		expect(inScope({ ...base, kind: 'archive', address: 'X@example.com' }, scope)).toBe(true);
		expect(inScope({ ...base, kind: 'user', address: 'y@example.com' }, scope)).toBe(false);
		expect(
			inScope(
				{ ...base, kind: 'archive', address: 'x@example.com' },
				{ ...scope, includeArchives: false }
			)
		).toBe(false);
	});

	it('follows the settings for shared mailboxes, resources, archives and exclusions', () => {
		const base = { excluded: false, address: 'x@example.com' };
		expect(inScope({ ...base, kind: 'user' }, SCOPE_DEFAULTS)).toBe(true);
		expect(inScope({ ...base, kind: 'room' }, SCOPE_DEFAULTS)).toBe(false);
		expect(inScope({ ...base, kind: 'shared' }, { ...SCOPE_DEFAULTS, includeShared: false })).toBe(
			false
		);
		expect(inScope({ ...base, kind: 'user', excluded: true }, SCOPE_DEFAULTS)).toBe(false);
		expect(
			inScope(
				{ ...base, kind: 'user' },
				{ ...SCOPE_DEFAULTS, excludedAddresses: ['x@example.com'] }
			)
		).toBe(false);
	});
});
