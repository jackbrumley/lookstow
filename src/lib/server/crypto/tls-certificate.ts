import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import {
	derBitString,
	derBoolean,
	derExplicit,
	derImplicit,
	derNull,
	derObjectId,
	derOctetString,
	derSequence,
	derSet,
	derSmallInteger,
	derTime,
	derUnsignedInteger,
	derUtf8String
} from './der.ts';

/**
 * The certificate the remote console serves HTTPS with (docs/specs/SPEC-REMOTE.md): self-signed,
 * RSA 2048 with SHA-256, valid for two years, naming this computer's host names and addresses so
 * a browser checks the name, and only warns that nobody it trusts signed it. Its SHA-256
 * fingerprint, shown in Settings, is what a person compares on first connecting.
 */
export type TlsCertificate = { certificatePem: string; privateKeyPem: string };

const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const COMMON_NAME = '2.5.4.3';
const ORGANISATION = '2.5.4.10';
const SUBJECT_ALT_NAME = '2.5.29.17';
const BASIC_CONSTRAINTS = '2.5.29.19';
const EXTENDED_KEY_USAGE = '2.5.29.37';
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const VALID_YEARS = 2;
const BACKDATE_MS = 60 * 60 * 1000;

function ipBytes(address: string): Buffer | null {
	if (isIPv4(address))
		return Buffer.from(address.split('.').map((part) => Number.parseInt(part, 10)));
	if (!isIPv6(address)) return null;
	const [head = '', tail = ''] = address.split('::');
	const words = (text: string) => (text === '' ? [] : text.split(':'));
	const front = words(head);
	const back = words(tail);
	const all = address.includes('::')
		? [...front, ...Array<string>(8 - front.length - back.length).fill('0'), ...back]
		: front;
	return Buffer.from(
		all.flatMap((word) => {
			const value = Number.parseInt(word, 16);
			return [value >> 8, value & 0xff];
		})
	);
}

export function makeTlsCertificate(
	commonName: string,
	names: readonly string[],
	now: number
): TlsCertificate {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const spki = publicKey.export({ format: 'der', type: 'spki' });
	const name = derSequence(
		derSet(derSequence(derObjectId(ORGANISATION), derUtf8String('Lookstow'))),
		derSet(derSequence(derObjectId(COMMON_NAME), derUtf8String(commonName)))
	);
	const alternatives = names.flatMap((entry) => {
		const ip = ipBytes(entry);
		if (ip !== null) return [derImplicit(7, ip)];
		return /^[a-z0-9.-]+$/i.test(entry) ? [derImplicit(2, Buffer.from(entry, 'ascii'))] : [];
	});
	const extensions = derExplicit(
		3,
		derSequence(
			derSequence(derObjectId(BASIC_CONSTRAINTS), derBoolean(true), derOctetString(derSequence())),
			derSequence(
				derObjectId(EXTENDED_KEY_USAGE),
				derOctetString(derSequence(derObjectId(SERVER_AUTH)))
			),
			derSequence(derObjectId(SUBJECT_ALT_NAME), derOctetString(derSequence(...alternatives)))
		)
	);
	const notBefore = new Date(now - BACKDATE_MS);
	const notAfter = new Date(now);
	notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALID_YEARS);
	const signatureAlgorithm = derSequence(derObjectId(SHA256_WITH_RSA), derNull());
	const serial = randomBytes(16);
	serial[0] = (serial[0] ?? 0) & 0x7f;
	const tbs = derSequence(
		derExplicit(0, derSmallInteger(2)),
		derUnsignedInteger(serial),
		signatureAlgorithm,
		name,
		derSequence(derTime(notBefore), derTime(notAfter)),
		name,
		spki,
		extensions
	);
	const signature = sign('sha256', tbs, privateKey);
	const certificate = derSequence(tbs, signatureAlgorithm, derBitString(signature, 0));
	const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
	return {
		certificatePem: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
		privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' })
	};
}

/** The SHA-256 fingerprint browsers show, as colon-separated hex pairs. */
export function tlsFingerprint(certificatePem: string): string {
	const raw = new X509Certificate(certificatePem).raw;
	return (createHash('sha256').update(raw).digest('hex').match(/../g) ?? [])
		.join(':')
		.toUpperCase();
}
