import type { Cookies } from '@sveltejs/kit';
import type { Queryable } from '../../database/connection.ts';
import { recordActivity } from '../activity/activity.ts';
import { readRemote, saveRemote } from '../settings/settings.ts';
import {
	SESSION_COOKIE,
	clearStrikes,
	endSession,
	locked,
	newSession,
	passwordMatches,
	strike
} from './accounts.ts';

/**
 * Signing a remote person in and out (docs/specs/SPEC-REMOTE.md). A wrong name and a wrong
 * password get the same answer, and both count towards the lockout of the name and of the
 * address it came from.
 */
const SESSION_SECONDS = 8 * 3_600;

/** Where to go after signing in: a path on this site only, never another site. */
export function safeNext(text: string | null): string {
	if (text === null || !text.startsWith('/') || text.startsWith('//') || text.includes('\\')) {
		return '/';
	}
	return text;
}

export type SignInResult = { ok: true } | { ok: false; message: string };

export async function signIn(
	db: Queryable,
	cookies: Cookies,
	username: string,
	password: string,
	address: string,
	now = Date.now()
): Promise<SignInResult> {
	const name = username.toLowerCase();
	const keys = [`user:${name}`, `ip:${address}`];
	if (locked(keys, now)) {
		return {
			ok: false,
			message: 'Too many wrong passwords. Sign-in is locked for 15 minutes; try again later.'
		};
	}
	const remote = readRemote(db);
	const account = remote.accounts.find((each) => each.username.toLowerCase() === name);
	// A missing account is checked against a throwaway hash too, so the answer takes as long.
	const matches = await passwordMatches(
		password,
		account?.passwordHash ??
			'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
	);
	if (account === undefined || !matches || account.disabled) {
		strike(keys, now);
		recordActivity(db, {
			level: 'warn',
			kind: 'remote',
			actor: 'remote',
			summary: `Remote sign-in refused for "${username.slice(0, 40)}" from ${address}`,
			detail: account?.disabled === true ? 'The account is disabled.' : 'Wrong name or password.'
		});
		return { ok: false, message: 'That name and password do not match an account.' };
	}
	clearStrikes(keys);
	const token = newSession(account.username, now);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'strict',
		maxAge: SESSION_SECONDS
	});
	saveRemote(db, {
		...remote,
		accounts: remote.accounts.map((each) =>
			each.username === account.username
				? { ...each, lastSignInAt: new Date(now).toISOString() }
				: each
		)
	});
	recordActivity(db, {
		level: 'info',
		kind: 'remote',
		actor: account.username,
		summary: `${account.username} signed in remotely from ${address}`
	});
	return { ok: true };
}

export function signOut(cookies: Cookies): void {
	endSession(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
}
