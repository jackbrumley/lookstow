/**
 * npm run release:key              makes the project's release key pair, once
 * npm run release:key -- --check   checks that every copy of the public key agrees (CI)
 *
 * The private key goes to keys/lookstow-release-key.pem (mode 0600; keys/ is ignored by git),
 * for you to store as the LOOKSTOW_RELEASE_KEY secret of the release workflow and then keep
 * offline. The public key is written everywhere it is trusted:
 *
 * - launcher/crates/lookstow/release-key.pub (raw base64): compiled into the launcher's updater
 * - src/lib/server/services/server-updates/release.ts (RELEASE_PUBLIC_KEY): the console's check
 * - docs/install.sh (RELEASE_KEY_PEM): the installer's signature check
 *
 * Replacing the key means installed servers refuse every release signed with the new one until
 * the installer is run again on them; do it only if the private key is lost or leaked.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { projectPublicKey, publicKeyOfPrivate, publicKeyPem } from './release/release-key.ts';
import { PUBLIC_KEY_FILE } from './release/targets.ts';

const PRIVATE_KEY_FILE = 'keys/lookstow-release-key.pem';
const APP_KEY_FILE = 'src/lib/server/services/server-updates/release.ts';
const INSTALLER = 'docs/install.sh';
const APP_KEY = /(export const RELEASE_PUBLIC_KEY = ')([^']*)(';)/;
const INSTALLER_KEY =
	/(RELEASE_KEY_PEM=")(-----BEGIN PUBLIC KEY-----\n[^"]*-----END PUBLIC KEY-----)(")/;

function fail(message: string): never {
	console.error(`release:key: ${message}`);
	process.exit(1);
}

function copies(): { app: string; installer: string } {
	const app = APP_KEY.exec(readFileSync(APP_KEY_FILE, 'utf8'))?.[2];
	const installer = INSTALLER_KEY.exec(readFileSync(INSTALLER, 'utf8'))?.[2];
	if (app === undefined) fail(`${APP_KEY_FILE} has no RELEASE_PUBLIC_KEY line`);
	if (installer === undefined) fail(`${INSTALLER} has no RELEASE_KEY_PEM block`);
	return { app, installer };
}

function replaceIn(path: string, pattern: RegExp, value: string): void {
	const text = readFileSync(path, 'utf8');
	writeFileSync(
		path,
		text.replace(pattern, (_whole, before: string, _old, after: string) => before + value + after)
	);
}

const { values } = parseArgs({ options: { check: { type: 'boolean' } } });

if (values.check === true) {
	const raw = projectPublicKey();
	const { app, installer } = copies();
	if (app !== raw) fail(`${APP_KEY_FILE} trusts ${app}, but ${PUBLIC_KEY_FILE} has ${raw}`);
	if (installer !== publicKeyPem(raw))
		fail(`${INSTALLER}'s RELEASE_KEY_PEM is not ${PUBLIC_KEY_FILE}`);
	console.log(`release:key: every copy of the public key is ${raw}`);
	process.exit(0);
}

if (existsSync(PRIVATE_KEY_FILE)) {
	fail(`${PRIVATE_KEY_FILE} already exists; move it away first (and read the comment at the top)`);
}
copies();
const privateKeyPem = generateKeyPairSync('ed25519').privateKey.export({
	format: 'pem',
	type: 'pkcs8'
});
const raw = publicKeyOfPrivate(privateKeyPem);
mkdirSync(dirname(PRIVATE_KEY_FILE), { recursive: true, mode: 0o700 });
writeFileSync(PRIVATE_KEY_FILE, privateKeyPem, { mode: 0o600, flag: 'wx' });
writeFileSync(PUBLIC_KEY_FILE, `${raw}\n`);
replaceIn(APP_KEY_FILE, APP_KEY, raw);
replaceIn(INSTALLER, INSTALLER_KEY, publicKeyPem(raw));
console.log(`release:key: private key ${PRIVATE_KEY_FILE}`);
console.log(`  public key ${raw}, written to ${PUBLIC_KEY_FILE}, ${APP_KEY_FILE} and ${INSTALLER}`);
console.log('  Store the private key as the release secret, then keep it offline:');
console.log(`  gh secret set LOOKSTOW_RELEASE_KEY < ${PRIVATE_KEY_FILE}`);
