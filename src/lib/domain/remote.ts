import type { LiveStatus } from './live-status.ts';

/**
 * Remote access rules (docs/specs/SPEC-REMOTE.md), pure so they are tested on their own: which
 * addresses may connect, and what a remote person may open. Remote access is read-only: the
 * dashboard, mailboxes, Search and messages (viewing and downloading), nothing that changes a
 * setting, a backup or the service.
 */

/** One allow-list entry: an IPv4 address or range (10.1.2.0/24), or an exact IPv6 address. */
export type AllowEntry =
	{ kind: 'v4'; base: number; bits: number } | { kind: 'v6'; address: string };

function ipv4Number(text: string): number | null {
	const parts = text.split('.');
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const byte = Number.parseInt(part, 10);
		if (byte > 255) return null;
		value = value * 256 + byte;
	}
	return value;
}

/** An allow-list line read, or null when it is not an address or range. */
export function parseAllowEntry(line: string): AllowEntry | null {
	const text = line.trim();
	const [address = '', bitsText] = text.split('/');
	const v4 = ipv4Number(address);
	if (v4 !== null) {
		const bits = bitsText === undefined ? 32 : Number.parseInt(bitsText, 10);
		if (!Number.isInteger(bits) || bits < 8 || bits > 32) return null;
		return { kind: 'v4', base: v4, bits };
	}
	if (bitsText === undefined && /^[0-9a-f:]+$/i.test(address) && address.includes(':')) {
		return { kind: 'v6', address: address.toLowerCase() };
	}
	return null;
}

/** The address a request came from, as Node reports it (IPv4 often as ::ffff:10.1.2.3). */
export function allowed(address: string, entries: readonly AllowEntry[]): boolean {
	const plain = address.replace(/^::ffff:/i, '');
	const v4 = ipv4Number(plain);
	return entries.some((entry) => {
		if (entry.kind === 'v6') return entry.address === plain.toLowerCase();
		if (v4 === null) return false;
		const size = 2 ** (32 - entry.bits);
		return Math.floor(v4 / size) === Math.floor(entry.base / size);
	});
}

/** Pages a remote person may open (and their data); everything else is refused. */
const REMOTE_PAGES = [
	/^\/$/,
	/^\/mailboxes(\/.*)?$/,
	/^\/search$/,
	/^\/messages\/.+$/,
	/^\/how-it-works$/
];
/** What any page needs: the app's own files and the status probe. */
const ALWAYS = [/^\/_app\//, /^\/favicon\.svg$/, /^\/healthz$/, /^\/signin$/];

/**
 * Whether a remote, signed-in person may make this request. Only reading (GET and HEAD), plus
 * signing out; a page's data (`…/__data.json`) follows its page.
 */
export function remoteMayOpen(method: string, pathname: string): boolean {
	if (method === 'POST') return pathname === '/signout';
	if (method !== 'GET' && method !== 'HEAD') return false;
	const page = pathname.replace(/\/__data\.json$/, '') || '/';
	return (
		REMOTE_PAGES.some((pattern) => pattern.test(page)) ||
		ALWAYS.some((pattern) => pattern.test(pathname))
	);
}

/** Requests that need no sign-in: the sign-in page itself, the app's files and the probe. */
export function openWithoutSignIn(pathname: string): boolean {
	return ALWAYS.some((pattern) => pattern.test(pathname));
}

/** Usernames: letters, digits, dots, dashes and underscores, 2 to 40 characters. */
export function validUsername(name: string): boolean {
	return /^[a-z0-9._-]{2,40}$/i.test(name);
}

/** Passwords: at least 12 characters (a passphrase is fine). */
export const PASSWORD_MIN = 12;

/**
 * The live status as the sign-in page may show it to someone not yet signed in: whether work
 * runs, never which mailboxes, folders, paths or problems.
 */
export function withoutNames(live: LiveStatus): LiveStatus {
	return {
		...live,
		engine: {
			...live.engine,
			problem: null,
			syncing: [],
			failing: {},
			disk: { ...live.engine.disk, path: '' },
			discovery: { ...live.engine.discovery, progress: null }
		}
	};
}

/** One line of the remote audit trail (<data>/remote-audit/YYYY-MM-DD.jsonl). */
export type RemoteAuditLine = {
	at: string;
	user: string | null;
	address: string;
	method: string;
	path: string;
	status: number;
};

/** Settings, Remote access: what the card shows. */
export type RemoteView = {
	enabled: boolean;
	port: number;
	allowList: string[];
	address: string;
	fingerprint: string | null;
	problem: string | null;
	accounts: {
		username: string;
		disabled: boolean;
		createdAt: string;
		lastSignInAt: string | null;
	}[];
	firewall: { windows: string; linux: string[] };
	audit: RemoteAuditLine[];
};
