import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Remote accounts' passwords and sessions (docs/specs/SPEC-REMOTE.md). Passwords are kept as
 * scrypt hashes (N 2^15, r 8, p 1, a 16-byte salt). Sessions live in memory: a restart signs
 * everyone out, which suits a handful of people. A session ends after 8 hours, or an hour after
 * its last request. Five wrong passwords for a name, or from an address, lock it for 15 minutes.
 */
const N = 32_768;
const KEY_BYTES = 32;
const SESSION_MS = 8 * 3_600_000;
const IDLE_MS = 3_600_000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
/** The cookie that carries a session: HttpOnly, Secure, SameSite=Strict. */
export const SESSION_COOKIE = 'lookstow_session';

function derive(password: string, salt: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, KEY_BYTES, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
			if (error === null) resolve(key);
			else reject(error);
		});
	});
}

/** `scrypt$<salt base64>$<hash base64>` */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(password, salt);
	return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function passwordMatches(password: string, stored: string): Promise<boolean> {
	const [kind, saltText, hashText] = stored.split('$');
	if (kind !== 'scrypt' || saltText === undefined || hashText === undefined) return false;
	const expected = Buffer.from(hashText, 'base64');
	const key = await derive(password, Buffer.from(saltText, 'base64'));
	return key.length === expected.length && timingSafeEqual(key, expected);
}

type Session = { username: string; createdAt: number; seenAt: number };
const sessions = new Map<string, Session>();

export function newSession(username: string, now = Date.now()): string {
	const token = randomBytes(32).toString('base64url');
	sessions.set(token, { username, createdAt: now, seenAt: now });
	return token;
}

/** The session's username, or null when it has ended (its age, idleness or a sign-out). */
export function sessionUser(token: string | undefined, now = Date.now()): string | null {
	if (token === undefined) return null;
	const session = sessions.get(token);
	if (session === undefined) return null;
	if (now - session.createdAt >= SESSION_MS || now - session.seenAt >= IDLE_MS) {
		sessions.delete(token);
		return null;
	}
	session.seenAt = now;
	return session.username;
}

export function endSession(token: string | undefined): void {
	if (token !== undefined) sessions.delete(token);
}

/** Ends every session of this person (disabled, deleted, or a new password). */
export function endSessionsOf(username: string): void {
	for (const [token, session] of sessions) {
		if (session.username === username) sessions.delete(token);
	}
}

type Strikes = { failures: number; lockedUntil: number };
const strikes = new Map<string, Strikes>();

/** Whether sign-in is locked for this name or address now. */
export function locked(keys: readonly string[], now = Date.now()): boolean {
	return keys.some((key) => (strikes.get(key)?.lockedUntil ?? 0) > now);
}

/** A wrong password: after LOCK_AFTER in a row, the name and address lock for LOCK_MS. */
export function strike(keys: readonly string[], now = Date.now()): void {
	for (const key of keys) {
		const current = strikes.get(key) ?? { failures: 0, lockedUntil: 0 };
		const failures = current.failures + 1;
		strikes.set(key, {
			failures: failures >= LOCK_AFTER ? 0 : failures,
			lockedUntil: failures >= LOCK_AFTER ? now + LOCK_MS : current.lockedUntil
		});
	}
}

export function clearStrikes(keys: readonly string[]): void {
	for (const key of keys) strikes.delete(key);
}
