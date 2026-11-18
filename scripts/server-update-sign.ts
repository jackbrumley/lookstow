/**
 * npm run release:sign -- --target <target> [--key <file>]
 *
 * Signs the bundle release-server.ts made (dist/release/lookstow-app-<target>.tar.gz) with the
 * offline release key, writing its manifest dist/release/lookstow-app-<target>.json: what
 * install.sh, the launcher's updater and the console's update check verify. The key comes from
 * the LOOKSTOW_RELEASE_KEY variable (the release workflow's secret) or from --key (a local
 * file, such as keys/lookstow-release-key.pem); it must match release-key.pub.
 *
 * Every release needs its entry in docs/server-update-compatibility.json: `minimumLauncher` is
 * the oldest installed version whose updater may install it by itself, and `rollbackFrom` lists
 * the versions tested to run on the database it leaves (the updater rolls back only to those).
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { compareVersions } from '../src/lib/domain/releases/version.ts';
import { stableVersionSchema } from '../src/lib/schemas/releases/server-updates.ts';
import { projectPublicKey, publicKeyOfPrivate } from './release/release-key.ts';
import {
	appArchiveName,
	COMPATIBILITY_FILE,
	isTarget,
	manifestName,
	nodeVersion,
	packageVersion,
	PUBLIC_KEY_FILE,
	SIGNING_DOMAIN
} from './release/targets.ts';

function fail(message: string): never {
	console.error(`release:sign: ${message}`);
	process.exit(1);
}

const OUT = join('dist', 'release');
const Compatibility = z.record(
	z.string(),
	z.strictObject({
		minimumLauncher: stableVersionSchema,
		rollbackFrom: z.array(stableVersionSchema).max(32)
	})
);

const { values } = parseArgs({
	options: { target: { type: 'string' }, key: { type: 'string' } }
});
const target = values.target ?? fail('give --target <target>');
if (!isTarget(target)) fail(`${target} is not a release target`);

const version = packageVersion();
const compatibility = Compatibility.parse(JSON.parse(readFileSync(COMPATIBILITY_FILE, 'utf8')));
const entry =
	compatibility[version] ??
	fail(`${COMPATIBILITY_FILE} has no entry for ${version}; add one, commit, then tag`);
if (compareVersions(entry.minimumLauncher, version) > 0) {
	fail('minimumLauncher cannot be newer than the release itself');
}
if (
	entry.rollbackFrom.some(
		(older, index, all) => compareVersions(older, version) >= 0 || all.indexOf(older) !== index
	)
) {
	fail('rollbackFrom must list unique, older releases');
}

const signingPem =
	values.key === undefined
		? (process.env['LOOKSTOW_RELEASE_KEY'] ?? '')
		: readFileSync(values.key, 'utf8');
if (signingPem.trim() === '') {
	fail('set LOOKSTOW_RELEASE_KEY or give --key <file>: nothing is released unsigned');
}
if (publicKeyOfPrivate(signingPem) !== projectPublicKey()) {
	fail(`the signing key does not match ${PUBLIC_KEY_FILE}, which installed launchers trust`);
}

const archive = join(OUT, appArchiveName(target));
const archiveBytes = readFileSync(archive);
if (archiveBytes.byteLength === 0 || archiveBytes.byteLength > 1024 ** 3) {
	fail(`${archive} is empty or over the 1 GiB limit`);
}
const payload = Buffer.from(
	JSON.stringify({
		schemaVersion: 1,
		version,
		target,
		archive: appArchiveName(target),
		bytes: archiveBytes.byteLength,
		sha256: createHash('sha256').update(archiveBytes).digest('hex'),
		minimumLauncher: entry.minimumLauncher,
		nodeMajor: Number.parseInt(nodeVersion(), 10),
		rollbackFrom: entry.rollbackFrom
	})
);
const signature = sign(
	null,
	Buffer.concat([Buffer.from(SIGNING_DOMAIN), payload]),
	createPrivateKey(signingPem)
);
const manifest = join(OUT, manifestName(target));
writeFileSync(
	manifest,
	`${JSON.stringify({ payload: payload.toString('base64'), signature: signature.toString('base64') })}\n`
);
console.log(`release:sign: signed Lookstow ${version} for ${target}: ${manifest}`);
