import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { certificateFacts } from '../../crypto/app-certificate.ts';

/**
 * App-only sign-in to Microsoft Entra (OAuth 2.0 client credentials). Lookstow is a daemon:
 * no user signs in; the app registration's application permissions decide what it may read.
 * A certificate is preferred (the private key never leaves this server); a client secret works
 * for a first test.
 */
export type GraphCredentials = {
	tenantId: string;
	clientId: string;
	auth:
		| { kind: 'secret'; secret: string }
		| { kind: 'certificate'; certificatePem: string; privateKeyPem: string };
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
/** Renew this long before expiry, so a token never runs out in the middle of a request. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;
/** Client assertions only need to live long enough to be sent. */
const ASSERTION_LIFETIME_S = 10 * 60;

export class TokenError extends Error {
	override name = 'TokenError';
}

/** Gets access tokens for Microsoft Graph and keeps one until shortly before it expires. */
export class TokenSource {
	#token: { value: string; expiresAt: number } | null = null;
	readonly #credentials: GraphCredentials;
	readonly #fetch: FetchLike;
	readonly #now: () => number;

	constructor(credentials: GraphCredentials, fetchImpl: FetchLike = fetch, now = Date.now) {
		this.#credentials = credentials;
		this.#fetch = fetchImpl;
		this.#now = now;
	}

	async accessToken(): Promise<string> {
		if (this.#token !== null && this.#token.expiresAt - RENEW_BEFORE_MS > this.#now()) {
			return this.#token.value;
		}
		const { tenantId, clientId, auth } = this.#credentials;
		const body = new URLSearchParams({
			client_id: clientId,
			scope: GRAPH_SCOPE,
			grant_type: 'client_credentials'
		});
		const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
		if (auth.kind === 'secret') {
			body.set('client_secret', auth.secret);
		} else {
			body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
			body.set(
				'client_assertion',
				clientAssertion(tokenUrl, clientId, auth.certificatePem, auth.privateKeyPem, this.#now())
			);
		}
		const response = await this.#fetch(tokenUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body
		});
		const reply: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			throw new TokenError(`Microsoft Entra refused the sign-in: ${entraErrorText(reply)}`);
		}
		const token = readToken(reply);
		this.#token = { value: token.accessToken, expiresAt: this.#now() + token.expiresInS * 1000 };
		return token.accessToken;
	}
}

/**
 * The signed JWT that proves Lookstow holds the certificate's key (RFC 7523), with the
 * `x5t#S256` header Entra uses to find the certificate on the app registration.
 */
export function clientAssertion(
	audience: string,
	clientId: string,
	certificatePem: string,
	privateKeyPem: string,
	now: number
): string {
	const issuedAt = Math.floor(now / 1000);
	const header = { alg: 'RS256', typ: 'JWT', 'x5t#S256': certificateFacts(certificatePem).x5tS256 };
	const claims = {
		aud: audience,
		iss: clientId,
		sub: clientId,
		jti: randomUUID(),
		nbf: issuedAt,
		iat: issuedAt,
		exp: issuedAt + ASSERTION_LIFETIME_S
	};
	const signingInput = `${base64url(header)}.${base64url(claims)}`;
	// RS256 (RSASSA-PKCS1-v1_5 with SHA-256): the algorithm every Entra tenant accepts.
	const signature = sign('sha256', Buffer.from(signingInput), createPrivateKey(privateKeyPem));
	return `${signingInput}.${signature.toString('base64url')}`;
}

function base64url(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function readToken(reply: unknown): { accessToken: string; expiresInS: number } {
	if (typeof reply === 'object' && reply !== null && 'access_token' in reply) {
		const accessToken = reply.access_token;
		const expiresIn = 'expires_in' in reply ? Number(reply.expires_in) : Number.NaN;
		if (typeof accessToken === 'string' && Number.isFinite(expiresIn) && expiresIn > 0) {
			return { accessToken, expiresInS: expiresIn };
		}
	}
	throw new TokenError('Microsoft Entra answered without an access token');
}

/** Entra's own words for a refused sign-in, first line only (the rest is trace ids). */
function entraErrorText(reply: unknown): string {
	if (typeof reply === 'object' && reply !== null) {
		const description =
			'error_description' in reply && typeof reply.error_description === 'string'
				? reply.error_description.split(/\r?\n/)[0]
				: undefined;
		const code = 'error' in reply && typeof reply.error === 'string' ? reply.error : undefined;
		if (description !== undefined && description !== '') {
			return description;
		}
		if (code !== undefined) {
			return code;
		}
	}
	return 'no reason given';
}
