import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../../database/connection.ts';
import { readAiAccess, saveAiAccess } from '../settings/settings.ts';

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
