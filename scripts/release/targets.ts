/**
 * What the release scripts share: the two release targets and their platforms, this computer's
 * target, file names, and the versions in package.json, .node-version and launcher/Cargo.toml.
 * Free of installed packages, so the release workflow's first job can use it straight after
 * checkout.
 */
import { readFileSync } from 'node:fs';
import { isStableVersion } from '../../src/lib/domain/releases/version.ts';

export const LAUNCHER_DIR = 'launcher';
const LAUNCHER_MANIFEST = 'launcher/Cargo.toml';
/** The release public key, raw 32-byte Ed25519 in base64; the launcher compiles it in. */
export const PUBLIC_KEY_FILE = 'launcher/crates/lookstow/release-key.pub';
/** Where server-update-compatibility.json lives (served by GitHub Pages, read by people). */
export const COMPATIBILITY_FILE = 'docs/server-update-compatibility.json';
/** First line of every signed manifest: the launcher's `updates::manifest::DOMAIN`. */
export const SIGNING_DOMAIN = 'LOOKSTOW-SERVER-UPDATE-1\n';

/** Release platforms: the Rust target, Node's own name, and whether install.ps1's zip is made. */
export const PLATFORMS = {
	'linux-x64': { target: 'x86_64-unknown-linux-gnu', node: 'linux-x64', zip: false },
	'windows-x64': { target: 'x86_64-pc-windows-msvc', node: 'win-x64', zip: true }
} as const;
export type Platform = keyof typeof PLATFORMS;
export type Target = (typeof PLATFORMS)[Platform]['target'];
const TARGETS: readonly Target[] = Object.values(PLATFORMS).map((spec) => spec.target);

export function isTarget(text: string): text is Target {
	return TARGETS.some((target) => target === text);
}

/** This computer's platform, or undefined where Lookstow has no release. */
export function hostPlatform(): Platform | undefined {
	switch (`${process.platform}-${process.arch}`) {
		case 'linux-x64':
			return 'linux-x64';
		case 'win32-x64':
			return 'windows-x64';
		default:
			return undefined;
	}
}

/** The executable name of a launcher binary on `target`. */
export function binaryName(name: string, target: Target): string {
	return target.includes('windows') ? `${name}.exe` : name;
}

export function appArchiveName(target: Target): string {
	return `lookstow-app-${target}.tar.gz`;
}

export function manifestName(target: Target): string {
	return `lookstow-app-${target}.json`;
}

/** install.ps1's archive: a `lookstow` folder, zipped. */
export const WINDOWS_ZIP = 'lookstow-windows-x64.zip';

/** package.json's version: the release version. */
export function packageVersion(): string {
	const parsed: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('version' in parsed) ||
		typeof parsed.version !== 'string' ||
		!isStableVersion(parsed.version)
	) {
		throw new Error('package.json has no x.y.z version');
	}
	return parsed.version;
}

/** The pinned Node version (.node-version), which every release carries. */
export function nodeVersion(): string {
	const version = readFileSync('.node-version', 'utf8').trim();
	if (!isStableVersion(version)) throw new Error(`.node-version has ${version}, not x.y.z`);
	return version;
}

/** `version = "x.y.z"` from launcher/Cargo.toml's [workspace.package], else its [package]. */
export function launcherVersion(): string {
	const text = readFileSync(LAUNCHER_MANIFEST, 'utf8');
	for (const section of ['workspace.package', 'package']) {
		const body = text.split(`[${section}]`)[1]?.split(/^\[/m)[0];
		const version = body === undefined ? undefined : /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
		if (version !== undefined) {
			if (!isStableVersion(version)) {
				throw new Error(`${LAUNCHER_MANIFEST} has version ${version}, not x.y.z`);
			}
			return version;
		}
	}
	throw new Error(`${LAUNCHER_MANIFEST} has no version`);
}
