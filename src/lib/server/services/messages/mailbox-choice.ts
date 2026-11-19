/**
 * Search's Mailbox field: the names it offers, and which mailbox a typed name or id means.
 * Two mailboxes can share an address (one gone from Microsoft 365, one found again later): the
 * list names each address once, and a typed address picks the one still in Microsoft 365.
 */
export type MailboxOption = { id: string; address: string; kind: string; goneAt: Date | null };

export type MailboxChoice = {
	/** Every name the field offers, each once, in the order given. */
	names: string[];
	/** The mailbox meant, or null for every mailbox (nothing typed) or no match. */
	chosen: { id: string; name: string; kind: string } | null;
	/** Something was typed and no mailbox has that name or id. */
	unknown: boolean;
};

export function mailboxName(address: string, kind: string): string {
	return kind === 'archive' ? `${address} (online archive)` : address;
}

export function chooseMailbox(options: readonly MailboxOption[], typed: string): MailboxChoice {
	const named = options
		.map((option) => ({ ...option, name: mailboxName(option.address, option.kind) }))
		.sort((a, b) => Number(a.goneAt !== null) - Number(b.goneAt !== null));
	const wanted = typed.trim().toLowerCase();
	const found =
		wanted === ''
			? undefined
			: named.find((option) => option.id === typed.trim() || option.name.toLowerCase() === wanted);
	return {
		names: [...new Set(options.map((option) => mailboxName(option.address, option.kind)))],
		chosen: found === undefined ? null : { id: found.id, name: found.name, kind: found.kind },
		unknown: wanted !== '' && found === undefined
	};
}
