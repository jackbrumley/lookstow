import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import {
	derBitString,
	derExplicit,
	derNull,
	derObjectId,
	derSequence,
	derSet,
	derSmallInteger,
	derTime,
	derUnsignedInteger,
	derUtf8String
} from './der.ts';

/**
 * The certificate Lookstow signs in to Microsoft Entra with (client credentials with a
 * certificate). Entra only accepts RSA keys for client assertions, so this is RSA 3072 with
 * SHA-256, self-signed, and valid for two years: long enough to run unattended, short enough
 * that a leaked key does not stay useful for ever. The admin uploads the certificate (never the
 * key) to the app registration.
 */
export type AppCertificate = {
	certificatePem: string;
	/** PKCS #8 PEM. Stored sealed with SECRETS_KEY, never shown. */
	privateKeyPem: string;
};

const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const COMMON_NAME = '2.5.4.3';
const ORGANISATION = '2.5.4.10';
const VALID_YEARS = 2;
/** Starts an hour early, so a slightly slow clock at Microsoft still accepts it at once. */
const BACKDATE_MS = 60 * 60 * 1000;

export function makeAppCertificate(commonName: string, now: number): AppCertificate {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
	const spki = publicKey.export({ format: 'der', type: 'spki' });
	const name = derSequence(
		derSet(derSequence(derObjectId(ORGANISATION), derUtf8String('Lookstow'))),
		derSet(derSequence(derObjectId(COMMON_NAME), derUtf8String(commonName)))
	);
	const notBefore = new Date(now - BACKDATE_MS);
	const notAfter = new Date(now);
	notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALID_YEARS);
	// RSA signature algorithms carry an explicit NULL parameter (RFC 4055).
	const signatureAlgorithm = derSequence(derObjectId(SHA256_WITH_RSA), derNull());
	// Serial: 16 random bytes, top bit cleared so it stays a positive 128-bit number.
	const serial = randomBytes(16);
	serial[0] = (serial[0] ?? 0) & 0x7f;
	const tbs = derSequence(
		derExplicit(0, derSmallInteger(2)),
		derUnsignedInteger(serial),
		signatureAlgorithm,
		name,
		derSequence(derTime(notBefore), derTime(notAfter)),
		name,
		spki
	);
	const signature = sign('sha256', tbs, privateKey);
	const certificate = derSequence(tbs, signatureAlgorithm, derBitString(signature, 0));
	return {
		certificatePem: toPem('CERTIFICATE', certificate),
		privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' })
	};
}

/** What the console shows about a certificate, and what Entra lists for it. */
export type CertificateFacts = {
	/** SHA-1 thumbprint in upper-case hex: the "Thumbprint" column in Entra. */
	thumbprint: string;
	/** SHA-256 of the DER certificate, base64url: the `x5t#S256` header of a client assertion. */
	x5tS256: string;
	validFrom: string;
	validTo: string;
	subject: string;
};

export function certificateFacts(certificatePem: string): CertificateFacts {
	const certificate = new X509Certificate(certificatePem);
	return {
		thumbprint: createHash('sha1').update(certificate.raw).digest('hex').toUpperCase(),
		x5tS256: createHash('sha256').update(certificate.raw).digest('base64url'),
		validFrom: new Date(certificate.validFrom).toISOString(),
		validTo: new Date(certificate.validTo).toISOString(),
		subject: certificate.subject
	};
}

function toPem(label: string, der: Buffer): string {
	const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
