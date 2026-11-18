import { X509Certificate, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeGraph, TEST_CREDENTIALS, json } from '#tests/support/fake-graph.ts';
import { certificateFacts, makeAppCertificate } from '../../crypto/app-certificate.ts';
import { clientAssertion, TokenError, TokenSource } from './token.ts';

describe('signing in to Microsoft Entra', () => {
	it('signs a client assertion Entra can check against the uploaded certificate', () => {
		const made = makeAppCertificate('test', Date.now());
		const audience = 'https://login.microsoftonline.com/t/oauth2/v2.0/token';
		const jwt = clientAssertion(
			audience,
			'client',
			made.certificatePem,
			made.privateKeyPem,
			1_000_000_000_000
		);
		const [header = '', claims = '', signature = ''] = jwt.split('.');
		const parsedHeader: unknown = JSON.parse(Buffer.from(header, 'base64url').toString());
		expect(parsedHeader).toEqual({
			alg: 'RS256',
			typ: 'JWT',
			'x5t#S256': certificateFacts(made.certificatePem).x5tS256
		});
		const parsedClaims: unknown = JSON.parse(Buffer.from(claims, 'base64url').toString());
		expect(parsedClaims).toMatchObject({
			aud: audience,
			iss: 'client',
			sub: 'client',
			iat: 1_000_000_000,
			exp: 1_000_000_600
		});
		const publicKey = new X509Certificate(made.certificatePem).publicKey;
		expect(
			verify(
				'sha256',
				Buffer.from(`${header}.${claims}`),
				publicKey,
				Buffer.from(signature, 'base64url')
			)
		).toBe(true);
	});

	it('keeps a token until five minutes before it expires', async () => {
		const graph = new FakeGraph().withToken();
		let now = 0;
		const tokens = new TokenSource(TEST_CREDENTIALS, graph.fetch, () => now);
		await tokens.accessToken();
		now = 54 * 60 * 1000;
		await tokens.accessToken();
		expect(graph.requests).toHaveLength(1);
		now = 56 * 60 * 1000;
		await tokens.accessToken();
		expect(graph.requests).toHaveLength(2);
	});

	it("passes Entra's own reason on when the sign-in is refused", async () => {
		const graph = new FakeGraph().on(/token$/, () =>
			json(
				{
					error: 'invalid_client',
					error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x'
				},
				401
			)
		);
		const tokens = new TokenSource(TEST_CREDENTIALS, graph.fetch);
		await expect(tokens.accessToken()).rejects.toThrow(
			new TokenError(
				'Microsoft Entra refused the sign-in: AADSTS7000215: Invalid client secret provided.'
			)
		);
	});
});
