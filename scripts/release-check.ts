/**
 * node scripts/release-check.ts <tag>
 *
 * The release workflow's first step: refuses a tag that is not v + package.json's version and
 * launcher/Cargo.toml's version, or whose version has no changelog entry, before anything is
 * built. Needs no installed packages.
 */
import { CHANGELOG } from '../src/lib/domain/releases/changelog.ts';
import { checkTag } from './release/check.ts';
import { releaseNotes } from './release/notes.ts';
import { launcherVersion, packageVersion } from './release/targets.ts';

const tag = process.argv[2] ?? '';
const result = checkTag(tag, packageVersion(), launcherVersion());
if (result.kind === 'refused') {
	console.error(`::error::${result.reason}`);
	process.exit(1);
}
const notes = releaseNotes(result.version, CHANGELOG);
if (notes.kind === 'missing') {
	console.error(`::error::${notes.reason}`);
	process.exit(1);
}
if (CHANGELOG[0].version !== result.version) {
	console.error(
		`::error::The newest changelog entry is ${CHANGELOG[0].version}, not ${result.version}.`
	);
	process.exit(1);
}
console.log(`release-check: ${tag} releases Lookstow ${result.version}`);
