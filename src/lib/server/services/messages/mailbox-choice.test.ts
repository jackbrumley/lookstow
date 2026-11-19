import { describe, expect, it } from 'vitest';
import { chooseMailbox, type MailboxOption } from './mailbox-choice.ts';

const OPTIONS: MailboxOption[] = [
	{ id: 'old', address: 'site@example.com', kind: 'user', goneAt: new Date(1) },
	{ id: 'ann', address: 'ann@example.com', kind: 'user', goneAt: null },
	{ id: 'ann-archive', address: 'ann@example.com', kind: 'archive', goneAt: null },
	{ id: 'new', address: 'site@example.com', kind: 'user', goneAt: null }
];

describe("Search's mailbox field", () => {
	it('names an address two mailboxes share once, and picks the one still in Microsoft 365', () => {
		const choice = chooseMailbox(OPTIONS, 'SITE@example.com');
		expect(choice.names).toEqual([
			'site@example.com',
			'ann@example.com',
			'ann@example.com (online archive)'
		]);
		expect(choice.chosen).toEqual({ id: 'new', name: 'site@example.com', kind: 'user' });
		expect(choice.unknown).toBe(false);
	});

	it('takes a mailbox id, an archive by its name, nothing, or says a name is unknown', () => {
		expect(chooseMailbox(OPTIONS, 'old').chosen?.id).toBe('old');
		expect(chooseMailbox(OPTIONS, 'ann@example.com (online archive)').chosen?.kind).toBe('archive');
		expect(chooseMailbox(OPTIONS, '')).toMatchObject({ chosen: null, unknown: false });
		expect(chooseMailbox(OPTIONS, 'nobody')).toMatchObject({ chosen: null, unknown: true });
	});
});
