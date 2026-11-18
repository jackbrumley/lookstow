import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certificateFacts, makeAppCertificate } from './app-certificate.ts';

describe('the Entra sign-in certificate', () => {
	const now = Date.UTC(2026, 10, 18, 12);
	const made = makeAppCertificate('Lookstow on test', now);

	it('is a self-signed RSA certificate that verifies with its own key', () => {
		const certificate = new X509Certificate(made.certificatePem);
		expect(certificate.subject).toContain('CN=Lookstow on test');
		expect(certificate.issuer).toBe(certificate.subject);
		expect(certificate.publicKey.asymmetricKeyType).toBe('rsa');
		expect(certificate.verify(certificate.publicKey)).toBe(true);
	});

	it('pairs with the private key it returns', () => {
		const fromKey = createPublicKey(createPrivateKey(made.privateKeyPem)).export({
			format: 'der',
			type: 'spki'
		});
		const fromCertificate = new X509Certificate(made.certificatePem).publicKey.export({
			format: 'der',
			type: 'spki'
		});
		expect(fromKey.equals(fromCertificate)).toBe(true);
	});

	it('is valid for two years from an hour before now', () => {
		const facts = certificateFacts(made.certificatePem);
		expect(new Date(facts.validFrom).getTime()).toBe(now - 3_600_000);
		expect(new Date(facts.validTo).getUTCFullYear()).toBe(2028);
	});

	it('reports the thumbprint Entra shows and the x5t#S256 a client assertion carries', () => {
		const facts = certificateFacts(made.certificatePem);
		expect(facts.thumbprint).toMatch(/^[0-9A-F]{40}$/);
		expect(facts.x5tS256).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
});
