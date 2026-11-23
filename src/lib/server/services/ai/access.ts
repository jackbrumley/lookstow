import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../../database/connection.ts';
import { readAiAccess, readRemote, saveAiAccess } from '../settings/settings.ts';

/**
 * Who may use the AI tools endpoint (/mcp): nobody until it is turned on in Settings, and then
 * only a caller on this computer (hooks.server.ts) that sends the access token as
 * `Authorization: Bearer <token>`. Only the token's SHA-256 is stored, so it is shown once.
 */
function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export function setAiEnabled(db: Queryable, enabled: boolean): void {
	saveAiAccess(db, { ...readAiAccess(db), enabled });
}

/** Makes a new access token (the old one stops working) and returns it, the only time it is shown. */
export function newAiToken(db: Queryable, now = Date.now()): string {
	const token = `lks_${randomBytes(32).toString('base64url')}`;
	saveAiAccess(db, {
		...readAiAccess(db),
		tokenSha256: sha256(token),
		tokenHint: token.slice(-4),
		tokenCreatedAt: new Date(now).toISOString()
	});
	return token;
}

export type AiAuthorisation = { ok: true } | { ok: false; status: 401 | 403; reason: string };

export function authoriseAi(db: Queryable, authorization: string | null): AiAuthorisation {
	const access = readAiAccess(db);
	if (!access.enabled || access.tokenSha256 === null) {
		return {
			ok: false,
			status: 403,
			reason: 'AI tools are turned off. Turn them on in Lookstow under Settings > AI tools.'
		};
	}
	const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
	if (token === undefined) {
		return {
			ok: false,
			status: 401,
			reason: 'Send the access token: Authorization: Bearer <token>'
		};
	}
	const given = Buffer.from(sha256(token), 'hex');
	const stored = Buffer.from(access.tokenSha256, 'hex');
	if (!timingSafeEqual(given, stored)) {
		return { ok: false, status: 401, reason: 'The access token is not the current one.' };
	}
	return { ok: true };
}

/** Who is using the AI tools: a remote account's name, or `this computer`. */
export type AiCaller = { ok: true; who: string } | { ok: false; status: 401 | 403; reason: string };

/**
 * The AI tools' routes: on the remote address the gate has already checked a remote account's
 * own token (hooks.server.ts, remote/gate.ts); on this computer, the access token from Settings.
 */
export function aiCaller(
	db: Queryable,
	locals: { remoteAiUser: string | null },
	authorization: string | null
): AiCaller {
	if (locals.remoteAiUser !== null) return { ok: true, who: locals.remoteAiUser };
	const local = authoriseAi(db, authorization);
	return local.ok ? { ok: true, who: 'this computer' } : local;
}

/**
 * Whether anything may use the AI tools, so the content index keeps reading messages: turned
 * on for this computer, or a remote account allowed them while remote access is on.
 */
export function aiToolsWanted(db: Queryable): boolean {
	if (readAiAccess(db).enabled) return true;
	const remote = readRemote(db);
	return remote.enabled && remote.accounts.some((account) => account.aiTools && !account.disabled);
}
