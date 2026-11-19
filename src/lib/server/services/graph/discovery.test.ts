import { describe, expect, it } from 'vitest';
import {
	FakeGraph,
	TEST_CREDENTIALS,
	graphError,
	json,
	noSleep
} from '#tests/support/fake-graph.ts';
import { GraphClient } from './client.ts';
import { unpacedGovernor } from './governor.ts';
import { discoverMailboxes } from './discovery.ts';
import { TokenSource } from './token.ts';

function tenant(): FakeGraph {
	return new FakeGraph()
		.withToken()
		.on(/^\/v1\.0\/users\?/, () =>
			json({
				value: [
					{ id: 'u1', displayName: 'Ann', mail: 'Ann@Example.com' },
					{ id: 'u2', displayName: 'Sales', mail: 'sales@example.com' },
					{ id: 'u3', displayName: 'Guest', mail: null },
					{ id: 'u4', displayName: 'No mailbox', mail: 'old@example.com' }
				]
			})
		)
		.on(/\/users\/u1\/mailboxSettings/, () => json({ userPurpose: 'user' }))
		.on(/\/users\/u2\/mailboxSettings/, () => json({ userPurpose: 'shared' }))
		.on(/\/users\/u4\/mailboxSettings/, () => graphError(404, 'MailboxNotEnabledForRESTAPI'));
}

function client(graph: FakeGraph): GraphClient {
	return new GraphClient(new TokenSource(TEST_CREDENTIALS, graph.fetch), {
		governor: unpacedGovernor(),
		fetch: graph.fetch,
		sleep: noSleep
	});
}

describe('mailbox discovery', () => {
	it('finds users and shared mailboxes, skipping users without a mailbox', async () => {
		const result = await discoverMailboxes(client(tenant()), { includeArchives: false });
		expect(result.mailboxes.map((m) => [m.address, m.kind])).toEqual([
			['ann@example.com', 'user'],
			['sales@example.com', 'shared']
		]);
		expect(result.usersChecked).toBe(3);
		expect(result.warnings).toEqual([]);
	});

	it('adds online archives as their own mailboxes', async () => {
		const graph = tenant()
			.on(/\/beta\/users\/u1\/settings\/exchange/, () =>
				json({ primaryMailboxId: 'p1', inPlaceArchiveMailboxId: 'a1' })
			)
			.on(/\/beta\/users\/u2\/settings\/exchange/, () => json({ primaryMailboxId: 'p2' }));
		const result = await discoverMailboxes(client(graph), { includeArchives: true });
		expect(result.mailboxes.filter((m) => m.kind === 'archive')).toEqual([
			{
				userId: 'u1',
				kind: 'archive',
				address: 'ann@example.com',
				displayName: 'Ann (archive)',
				exchangeMailboxId: 'a1'
			}
		]);
	});

	it('says once that archives cannot be listed when the permission is missing', async () => {
		const graph = tenant().on(/\/beta\/users\/.*\/settings\/exchange/, () =>
			graphError(403, 'ErrorAccessDenied')
		);
		const result = await discoverMailboxes(client(graph), { includeArchives: true });
		expect(result.mailboxes).toHaveLength(2);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(/Online archives could not be listed/);
	});
});
