import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RemoteAccount, RemoteSettings } from '../settings/settings.ts';

/**
 * Remote accounts' own tokens for the AI tools (docs/specs/SPEC-REMOTE.md): an AI agent on
 * another computer (Claude Code) sends one as `Authorization: Bearer <token>` to the remote
 * address's /mcp. Only its SHA-256 and last four characters are kept, so it is shown once.
 */
function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export type MadeToken = { token: string; sha256: string; hint: string };

export function makeAiToken(): MadeToken {
	const token = `lksr_${randomBytes(32).toString('base64url')}`;
	return { token, sha256: sha256(token), hint: token.slice(-4) };
}

/** The bearer token in an Authorization header, or null. */
export function bearerToken(authorization: string | null): string | null {
	return /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1] ?? null;
}

/** The account whose AI token this is, if it may use the AI tools now (allowed, not disabled). */
export function accountForAiToken(
	remote: RemoteSettings,
	token: string | null
): RemoteAccount | null {
	if (token === null) return null;
	const given = Buffer.from(sha256(token), 'hex');
	for (const account of remote.accounts) {
		if (!account.aiTools || account.disabled || account.aiTokenSha256 === null) continue;
		const stored = Buffer.from(account.aiTokenSha256, 'hex');
		if (stored.length === given.length && timingSafeEqual(stored, given)) return account;
	}
	return null;
}
