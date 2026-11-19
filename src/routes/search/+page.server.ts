import type { PageServerLoad } from './$types';
import { database } from '#lib/server/runtime.ts';
import { allMailboxes } from '#lib/server/services/mailboxes/repository.ts';
import { chooseMailbox } from '#lib/server/services/messages/mailbox-choice.ts';
import { searchMessages } from '#lib/server/services/messages/search.ts';
import { SEARCH_PAGE_SIZE, type MessageQuery } from '#lib/domain/messages.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(url: URL, name: string): string {
	return (url.searchParams.get(name) ?? '').trim().slice(0, 300);
}

function date(url: URL, name: string): string {
	const value = text(url, name);
	return DATE.test(value) ? value : '';
}

/** Search the stored messages. Every field is in the address, so a search can be bookmarked. */
export const load = (({ url }) => {
	// The field takes what was typed or picked (an address, "(online archive)" for an archive),
	// or a mailbox id from a mailbox page's Search this mailbox.
	const typed = text(url, 'mailbox');
	const choice = chooseMailbox(allMailboxes(database), typed);
	const query: MessageQuery = {
		mailboxId: choice.chosen?.id ?? null,
		text: text(url, 'q'),
		from: text(url, 'from'),
		to: text(url, 'to'),
		subject: text(url, 'subject'),
		folder: text(url, 'folder'),
		messageId: text(url, 'messageId'),
		after: date(url, 'after'),
		before: date(url, 'before'),
		includeDeleted: url.searchParams.get('deleted') === 'on'
	};
	// An empty address shows the form only; any field (even blank) runs the search.
	const asked = url.searchParams.size > 0;
	const page = Math.max(0, Math.min(10_000, Number.parseInt(text(url, 'page'), 10) || 0));
	// A mailbox that matches nothing is said plainly, not silently widened to every mailbox.
	const result = asked && !choice.unknown ? searchMessages(database, query, page) : null;
	return {
		mailboxes: choice.names,
		mailboxText: choice.chosen?.name ?? typed,
		unknownMailbox: choice.unknown,
		searchingArchive: choice.chosen?.kind === 'archive',
		query,
		page,
		pageSize: SEARCH_PAGE_SIZE,
		hits: result?.hits ?? [],
		total: result?.total ?? null
	};
}) satisfies PageServerLoad;
