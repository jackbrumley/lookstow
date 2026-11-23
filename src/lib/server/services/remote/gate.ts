import type { RequestEvent } from '@sveltejs/kit';
import type { Queryable } from '../../database/connection.ts';
import { readRemote } from '../settings/settings.ts';
import { SESSION_COOKIE, sessionUser } from './accounts.ts';
import {
	allowed,
	openWithoutSignIn,
	parseAllowEntry,
	remoteMayOpen,
	type AllowEntry
} from '../../../domain/remote.ts';

/**
 * The remote listener's gate (docs/specs/SPEC-REMOTE.md), in this order: remote access is on;
 * the address is on the allow-list; the person is signed in with an account that is not
 * disabled (else the sign-in page); and the request only reads. Returns the refusal, or null
 * with `remoteUser` set (null only for the sign-in page and the app's own files).
 */
function plain(status: number, text: string): Response {
	return new Response(text, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
}

export function remoteGate(
	db: Queryable,
	event: Pick<RequestEvent, 'cookies' | 'request' | 'url' | 'locals' | 'isDataRequest'>,
	address: string
): Response | null {
	const remote = readRemote(db);
	if (!remote.enabled) return plain(403, 'Remote access to Lookstow is turned off.');
	const entries = remote.allowList
		.map(parseAllowEntry)
		.filter((entry): entry is AllowEntry => entry !== null);
	if (!allowed(address, entries)) {
		return plain(403, `This computer (${address}) is not on Lookstow's remote access list.`);
	}
	const name = sessionUser(event.cookies.get(SESSION_COOKIE));
	const account = remote.accounts.find((each) => each.username === name && !each.disabled);
	event.locals.remoteUser = account?.username ?? null;
	event.locals.remoteMayExport = account?.evidencePacks ?? false;
	const path = event.url.pathname;
	if (openWithoutSignIn(path)) return null;
	if (account === undefined) {
		// SvelteKit takes /__data.json off the path before this hook; such a fetch (moving between
		// pages) is sent to sign in the way the client follows, a page by a 303.
		const isPage = event.request.method === 'GET';
		if (!isPage) return plain(401, 'Sign in to Lookstow first.');
		const location = `/signin?next=${encodeURIComponent(`${path}${event.url.search}`)}`;
		if (event.isDataRequest) {
			return new Response(JSON.stringify({ type: 'redirect', location }), {
				headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
			});
		}
		return new Response(null, { status: 303, headers: { location } });
	}
	if (!remoteMayOpen(event.request.method, path, account.evidencePacks)) {
		return plain(
			403,
			'This part of Lookstow is only on the computer it runs on. From here you can search, open and download messages.'
		);
	}
	return null;
}
