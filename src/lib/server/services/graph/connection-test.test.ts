import { describe, expect, it } from 'vitest';
import { FakeGraph, TEST_CREDENTIALS, graphError, json } from '#tests/support/fake-graph.ts';
import { testConnection } from './connection-test.ts';

const NO_MAILBOX = () =>
	graphError(
		404,
		'MailboxNotEnabledForRESTAPI',
		'The mailbox is either inactive, soft-deleted, or is hosted on-premise.'
	);

function tenant(): FakeGraph {
	return new FakeGraph()
		.withToken()
		.on(/^\/v1\.0\/users\?/, () =>
			json({
				value: [
					{ id: 'gone', mail: 'left@example.com' },
					{ id: 'nomail', mail: null },
					{ id: 'ann', mail: 'ann@example.com' }
				]
			})
		)
		.on(/\/users\/gone\/mailboxSettings/, NO_MAILBOX);
}

describe('Test connection', () => {
	it('skips users without a mailbox and tests on the next one', async () => {
		const graph = tenant()
			.on(/\/users\/ann\/mailboxSettings/, () => json({ userPurpose: 'user' }))
			.on(/\/users\/ann\/mailFolders/, () => json({ value: [{ id: 'inbox' }] }));
		const steps = await testConnection(TEST_CREDENTIALS, graph.fetch);
		expect(steps.every((step) => step.ok)).toBe(true);
		expect(steps[2]?.detail).toBe(
			'Allowed, on ann@example.com (1 user without a mailbox skipped).'
		);
	});

	it('names the missing permission when the mailbox read is refused', async () => {
		const graph = tenant().on(/\/users\/ann\/mailboxSettings/, () =>
			graphError(403, 'ErrorAccessDenied', 'Access is denied.')
		);
		const steps = await testConnection(TEST_CREDENTIALS, graph.fetch);
		expect(steps.at(-1)).toMatchObject({
			ok: false,
			name: 'Read mailbox settings (MailboxSettings.Read)'
		});
		expect(steps.at(-1)?.detail).toMatch(/MailboxSettings\.Read and grant admin consent/);
	});

	it('says plainly when no sampled user has a mailbox', async () => {
		const graph = tenant().on(/\/users\/ann\/mailboxSettings/, NO_MAILBOX);
		const steps = await testConnection(TEST_CREDENTIALS, graph.fetch);
		expect(steps.at(-1)?.detail).toMatch(/None of the first 2 users/);
	});
});
