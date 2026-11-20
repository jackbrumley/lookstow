import { STATE_LABELS, type MailboxState, type MailboxSummary } from './mailboxes.ts';

/**
 * The Mailboxes page's list: filtered, sorted and cut into pages on the server, so the page
 * receives one page of rows, not every mailbox a large tenant has (docs/specs/SPEC-SCALE.md).
 * Every choice is in the address, so a view can be bookmarked and the dashboard can link to one.
 */
export type StateFilter = MailboxState | 'in-backup' | 'all' | 'checking' | 'needs-look';
export type SortKey = 'address' | 'kind' | 'state' | 'itemCount' | 'byteCount' | 'lastSync';

export const MAILBOX_PAGE_SIZE = 100;

export type MailboxListQuery = {
	search: string;
	state: StateFilter;
	kind: string;
	sort: SortKey;
	descending: boolean;
	page: number;
};

export type MailboxList = {
	rows: MailboxSummary[];
	/** Mailboxes the filters match, and all there are. */
	matching: number;
	total: number;
	page: number;
	pageCount: number;
	kinds: string[];
	incomplete: { checking: number; 'needs-look': number };
};

const SORT_KEYS: readonly SortKey[] = [
	'address',
	'kind',
	'state',
	'itemCount',
	'byteCount',
	'lastSync'
];

function isStateFilter(value: string): value is StateFilter {
	return (
		value === 'in-backup' ||
		value === 'all' ||
		value === 'checking' ||
		value === 'needs-look' ||
		value in STATE_LABELS
	);
}

function isSortKey(value: string): value is SortKey {
	return SORT_KEYS.some((key) => key === value);
}

/**
 * The list's choices from the address; anything missing or unknown takes its default. `order`
 * is `<column>:asc` or `<column>:desc`. The page's form carries the current order and a clicked
 * column's button its own, so the last `order` (and `page`) given wins.
 */
export function mailboxListQuery(
	params: Pick<URLSearchParams, 'get' | 'getAll'>
): MailboxListQuery {
	const state = params.get('state') ?? '';
	const [sort = '', direction = ''] = (params.getAll('order').at(-1) ?? '').split(':');
	return {
		search: (params.get('q') ?? '').trim().slice(0, 200),
		state: isStateFilter(state) ? state : 'in-backup',
		kind: params.get('kind') ?? 'all',
		sort: isSortKey(sort) ? sort : 'address',
		descending: direction === 'desc',
		page: Math.max(0, Number.parseInt(params.getAll('page').at(-1) ?? '0', 10) || 0)
	};
}

/** Numbers and dates read best largest and newest first. */
export function sortsDescending(key: SortKey): boolean {
	return key === 'itemCount' || key === 'byteCount' || key === 'lastSync';
}

function matchesState(mailbox: MailboxSummary, state: StateFilter): boolean {
	if (state === 'all') return true;
	if (state === 'in-backup')
		return mailbox.state !== 'out-of-scope' && mailbox.state !== 'excluded';
	if (state === 'checking' || state === 'needs-look') return mailbox.completeness === state;
	return mailbox.state === state;
}

function sortValue(mailbox: MailboxSummary, key: SortKey): string | number {
	switch (key) {
		case 'address':
			return mailbox.address;
		case 'kind':
			return mailbox.kind;
		case 'state':
			return STATE_LABELS[mailbox.state];
		case 'itemCount':
			return mailbox.itemCount;
		case 'byteCount':
			return mailbox.byteCount;
		case 'lastSync':
			return mailbox.lastSyncFinishedAt ?? '';
	}
}

export function mailboxList(all: readonly MailboxSummary[], query: MailboxListQuery): MailboxList {
	const text = query.search.toLowerCase();
	const shown = all.filter(
		(mailbox) =>
			matchesState(mailbox, query.state) &&
			(query.kind === 'all' || mailbox.kind === query.kind) &&
			(text === '' ||
				mailbox.address.includes(text) ||
				mailbox.displayName.toLowerCase().includes(text))
	);
	const sorted = shown.sort((a, b) => {
		const left = sortValue(a, query.sort);
		const right = sortValue(b, query.sort);
		const order =
			typeof left === 'number' && typeof right === 'number'
				? left - right
				: String(left).localeCompare(String(right));
		return query.descending ? -order : order;
	});
	const pageCount = Math.max(1, Math.ceil(sorted.length / MAILBOX_PAGE_SIZE));
	// A narrower filter can leave fewer pages than the one asked for: show the last there is.
	const page = Math.min(query.page, pageCount - 1);
	return {
		rows: sorted.slice(page * MAILBOX_PAGE_SIZE, (page + 1) * MAILBOX_PAGE_SIZE),
		matching: sorted.length,
		total: all.length,
		page,
		pageCount,
		kinds: [...new Set(all.map((mailbox) => mailbox.kind))].sort(),
		incomplete: {
			checking: all.filter((mailbox) => mailbox.completeness === 'checking').length,
			'needs-look': all.filter((mailbox) => mailbox.completeness === 'needs-look').length
		}
	};
}
