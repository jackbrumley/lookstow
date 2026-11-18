/**
 * Whether a pushed tag may be released, decided before anything is built: it must be `vX.Y.Z`,
 * equal to package.json's version (which is also the changelog's newest entry) and to the
 * launcher's version in launcher/Cargo.toml, so the app and its launcher ship as one number.
 */
export type TagCheck = { kind: 'release'; version: string } | { kind: 'refused'; reason: string };

export function checkTag(tag: string, packageVersion: string, launcherVersion: string): TagCheck {
	const version = tag.startsWith('v') ? tag.slice(1) : '';
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
		return { kind: 'refused', reason: `Tag ${tag} is not vX.Y.Z.` };
	}
	if (version !== packageVersion) {
		return {
			kind: 'refused',
			reason: `Tag ${tag} does not match package.json version ${packageVersion}. Bump package.json, commit, then tag.`
		};
	}
	if (version !== launcherVersion) {
		return {
			kind: 'refused',
			reason: `Tag ${tag} does not match launcher/Cargo.toml version ${launcherVersion}. Set [workspace.package] version, commit, then tag.`
		};
	}
	return { kind: 'release', version };
}
