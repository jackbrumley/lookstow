/**
 * The release key's public half in the forms each reader needs. launcher/crates/lookstow/
 * release-key.pub holds the raw 32-byte Ed25519 key in standard base64 (what the launcher
 * compiles in); a SubjectPublicKeyInfo PEM there is read too. install.sh carries the PEM.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PUBLIC_KEY_FILE } from './targets.ts';

/** An Ed25519 SubjectPublicKeyInfo is this fixed 12-byte header, then the 32-byte key. */
const SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

/** Raw base64 of an Ed25519 public key object. */
function rawPublicKey(key: KeyObject): string {
	const spki = key.export({ format: 'der', type: 'spki' });
	return spki.subarray(spki.byteLength - 32).toString('base64');
}

/** The raw base64 public key of a PKCS #8 PEM private key; throws unless it is Ed25519. */
export function publicKeyOfPrivate(privateKeyPem: string): string {
	const key = createPrivateKey(privateKeyPem);
	if (key.asymmetricKeyType !== 'ed25519') throw new Error('The release key must be Ed25519.');
	return rawPublicKey(createPublicKey(key));
}

/** The project's public key from release-key.pub, as raw base64. */
export function projectPublicKey(): string {
	const text = readFileSync(PUBLIC_KEY_FILE, 'utf8').trim();
	if (text.startsWith('-----BEGIN PUBLIC KEY-----')) {
		const key = createPublicKey(text);
		if (key.asymmetricKeyType !== 'ed25519') {
			throw new Error(`${PUBLIC_KEY_FILE} is not an Ed25519 key`);
		}
		return rawPublicKey(key);
	}
	if (Buffer.from(text, 'base64').length !== 32) {
		throw new Error(`${PUBLIC_KEY_FILE} is not a 32-byte Ed25519 key in base64`);
	}
	return text;
}

/** The SubjectPublicKeyInfo PEM of a raw base64 key, as install.sh prints it. */
export function publicKeyPem(raw: string): string {
	const key = createPublicKey({
		key: Buffer.concat([SPKI_HEADER, Buffer.from(raw, 'base64')]),
		format: 'der',
		type: 'spki'
	});
	return key.export({ format: 'pem', type: 'spki' }).trim();
}
