import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { eq, lt, or } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { remoteSessions } from '../../database/schema.ts';

/**
 * Remote accounts' passwords and sessions (docs/specs/SPEC-REMOTE.md). Passwords are kept as
 * scrypt hashes (N 2^15, r 8, p 1, a 16-byte salt). A sign-in is remembered (in the database,
 * as the SHA-256 of its token, so restarts and updates keep it) for 7 days, or until it has gone
 * 48 hours unused. Five wrong passwords for a username, or from an address, lock it for 15
 * minutes.
 */
const N = 32_768;
const KEY_BYTES = 32;
export const SESSION_MS = 7 * 24 * 3_600_000;
const IDLE_MS = 48 * 3_600_000;
/** Last use is written at most this often, not on every request. */
const SEEN_EVERY_MS = 5 * 60_000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
/**
 * The cookie that carries a session: HttpOnly, Secure, SameSite=Lax (Strict would drop it when a
 * link to a message is opened from Outlook or Teams, which then looked like being signed out).
 */
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

function hashed(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function newSession(db: Queryable, username: string, now = Date.now()): string {
	const token = randomBytes(32).toString('base64url');
	// Ended sessions are cleared now and then; a sign-in is a good moment.
	db.delete(remoteSessions)
		.where(
			or(
				lt(remoteSessions.createdAt, new Date(now - SESSION_MS)),
				lt(remoteSessions.seenAt, new Date(now - IDLE_MS))
			)
		)
		.run();
	db.insert(remoteSessions)
		.values({
			tokenSha256: hashed(token),
			username,
			createdAt: new Date(now),
			seenAt: new Date(now)
		})
		.run();
	return token;
}

/** The session's username, or null when it has ended (its age, idleness or a sign-out). */
export function sessionUser(
	db: Queryable,
	token: string | undefined,
	now = Date.now()
): string | null {
	if (token === undefined || token === '') return null;
	const key = hashed(token);
	const session = db.select().from(remoteSessions).where(eq(remoteSessions.tokenSha256, key)).get();
	if (session === undefined) return null;
	const created = session.createdAt.getTime();
	const seen = session.seenAt.getTime();
	if (now - created >= SESSION_MS || now - seen >= IDLE_MS) {
		db.delete(remoteSessions).where(eq(remoteSessions.tokenSha256, key)).run();
		return null;
	}
	if (now - seen >= SEEN_EVERY_MS) {
		db.update(remoteSessions)
			.set({ seenAt: new Date(now) })
			.where(eq(remoteSessions.tokenSha256, key))
			.run();
	}
	return session.username;
}

export function endSession(db: Queryable, token: string | undefined): void {
	if (token === undefined || token === '') return;
	db.delete(remoteSessions)
		.where(eq(remoteSessions.tokenSha256, hashed(token)))
		.run();
}

/** Ends every session of this person (disabled, deleted, or a new password). */
export function endSessionsOf(db: Queryable, username: string): void {
	db.delete(remoteSessions).where(eq(remoteSessions.username, username)).run();
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
