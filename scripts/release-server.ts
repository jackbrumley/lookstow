/**
 * npm run release:local [-- --launcher <file>]
 *
 * Builds this computer's release in dist/release/ (docs/RELEASE.md): the SvelteKit build,
 * server.ts bundled into app/server.js (scripts/release/app-entries.ts), production
 * node_modules for this platform (better-sqlite3's prebuilt binary only), the migrations, the
 * Node runtime pinned in .node-version (checked against nodejs.org's SHASUMS256.txt), the
 * lookstow launcher, VERSION and LICENSE.
 *
 * The bundle is lookstow-app-<target>.tar.gz, its files at the top level: the archive install.sh
 * and the launcher's updater install, once server-update-sign.ts has signed its manifest.
 * Windows also gets lookstow-windows-x64.zip (a `lookstow` folder) for install.ps1.
 *
 * Without --launcher the launcher is built here with cargo (`cargo build --release -p lookstow`
 * in launcher/). The release workflow passes --launcher, a binary built beforehand (on Linux
 * against glibc 2.31).
 *
 * It always packages for the computer it runs on, because node_modules holds a native module.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bundleAppEntries } from './release/app-entries.ts';
import {
	appArchiveName,
	binaryName,
	hostPlatform,
	LAUNCHER_DIR,
	launcherVersion,
	nodeVersion as pinnedNodeVersion,
	packageVersion,
	PLATFORMS,
	WINDOWS_ZIP
} from './release/targets.ts';

function fail(message: string): never {
	console.error(`release:local: ${message}`);
	process.exit(1);
}

function run(
	command: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): void {
	// npm is a .cmd script on Windows, which only a shell can start; its arguments here are
	// fixed words, so they are passed as one command line (Node warns about separate ones).
	const shell = process.platform === 'win32' && command === 'npm';
	const result = shell
		? spawnSync([command, ...args].join(' '), { stdio: 'inherit', shell, ...options })
		: spawnSync(command, args, { stdio: 'inherit', ...options });
	if (result.status !== 0) {
		fail(`${command} ${args.join(' ')} failed (exit ${String(result.status)})`);
	}
}

const { values: options } = parseArgs({ options: { launcher: { type: 'string' } } });

const version = packageVersion();
if (launcherVersion() !== version) {
	fail(`launcher/Cargo.toml has ${launcherVersion()} but package.json has ${version}; set both`);
}
const nodeVersion = pinnedNodeVersion();
const platform =
	hostPlatform() ?? fail(`no release for this computer (${process.platform}-${process.arch})`);
const spec = PLATFORMS[platform];
const target = spec.target;
const launcherName = binaryName('lookstow', target);

const DIST = resolve('dist');
const STAGE = join(DIST, 'stage', platform);
const BUNDLE = join(STAGE, 'lookstow');
const APP = join(BUNDLE, 'app');
const CACHE = join(DIST, 'cache');
const OUT = join(DIST, 'release');
/** Windows' own bsdtar reads and writes zip files; a Git Bash tar on PATH cannot. */
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

/**
 * `vite build` analyses the server routes, which opens the database: a throwaway in-memory one,
 * never the developer's file.
 */
function buildApp(): void {
	run(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
		env: {
			...process.env,
			DATABASE_PATH: ':memory:',
			SECRETS_KEY: Buffer.alloc(32).toString('base64')
		}
	});
}

/** Production dependencies for this platform, without build-only files. */
function installDependencies(): void {
	copyFileSync('package.json', join(APP, 'package.json'));
	copyFileSync('package-lock.json', join(APP, 'package-lock.json'));
	// better-sqlite3 ships prebuilt binaries, so no install script needs to run.
	run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: APP });
	rmSync(join(APP, 'node_modules', '.bin'), { recursive: true, force: true });
	// C headers for compiling better-sqlite3; the prebuilt binary does not load them.
	rmSync(join(APP, 'node_modules', 'node-addon-api'), { recursive: true, force: true });
	const sqlite = join(APP, 'node_modules', 'better-sqlite3');
	rmSync(join(sqlite, 'deps'), { recursive: true, force: true });
	rmSync(join(sqlite, 'src'), { recursive: true, force: true });
	const keep = `${process.platform}-${process.arch}.node`;
	const prebuilds = join(sqlite, 'prebuilds');
	if (!existsSync(join(prebuilds, keep))) {
		fail(`better-sqlite3 has no prebuilt binary ${keep}`);
	}
	for (const prebuild of readdirSync(prebuilds)) {
		if (prebuild !== keep) {
			rmSync(join(prebuilds, prebuild), { recursive: true, force: true });
		}
	}
	rmSync(join(APP, 'package-lock.json'));
	// Only what Node needs to load ES modules; scripts and devDependencies are gone.
	writeFileSync(
		join(APP, 'package.json'),
		`${JSON.stringify({ name: 'lookstow', version, private: true, type: 'module', license: 'AGPL-3.0-only' }, null, '\t')}\n`
	);
}

function copyApp(): void {
	cpSync('build', join(APP, 'build'), { recursive: true });
	// connection.ts finds them relative to the working directory, app/.
	const migrations = join('src', 'lib', 'server', 'database', 'migrations');
	cpSync(migrations, join(APP, migrations), { recursive: true });
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

async function download(url: string, path: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) {
		fail(`download failed: ${url} (${String(response.status)})`);
	}
	writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

function sha256(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The pinned Node release for this platform, checked against nodejs.org's sums. */
async function addNode(): Promise<void> {
	const base = `https://nodejs.org/dist/v${nodeVersion}`;
	const name = `node-v${nodeVersion}-${spec.node}`;
	const file = `${name}.${platform === 'windows-x64' ? 'zip' : 'tar.xz'}`;
	mkdirSync(CACHE, { recursive: true });
	const archive = join(CACHE, file);
	const sums = join(CACHE, `SHASUMS256-${nodeVersion}.txt`);
	if (!existsSync(sums)) {
		await download(`${base}/SHASUMS256.txt`, sums);
	}
	const expected = readFileSync(sums, 'utf8')
		.split('\n')
		.map((line) => line.trim().split(/\s+/))
		.find(([, listed]) => listed === file)?.[0];
	if (expected === undefined) {
		fail(`${file} is not listed in Node's SHASUMS256.txt`);
	}
	if (!existsSync(archive) || sha256(archive) !== expected) {
		await download(`${base}/${file}`, archive);
	}
	if (sha256(archive) !== expected) {
		fail(`${file} does not match Node's SHASUMS256.txt`);
	}

	const unpacked = join(CACHE, name);
	rmSync(unpacked, { recursive: true, force: true });
	run(TAR, ['-xf', archive, '-C', CACHE]);
	const nodeDir = join(BUNDLE, 'node');
	if (platform === 'windows-x64') {
		mkdirSync(nodeDir, { recursive: true });
		copyFileSync(join(unpacked, 'node.exe'), join(nodeDir, 'node.exe'));
	} else {
		mkdirSync(join(nodeDir, 'bin'), { recursive: true });
		copyFileSync(join(unpacked, 'bin', 'node'), join(nodeDir, 'bin', 'node'));
		chmodSync(join(nodeDir, 'bin', 'node'), 0o755);
	}
	copyFileSync(join(unpacked, 'LICENSE'), join(nodeDir, 'LICENSE'));
	rmSync(unpacked, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The launcher
// ---------------------------------------------------------------------------

/** This computer's launcher, built here. */
function buildLauncher(): string {
	run('cargo', ['build', '--release', '-p', 'lookstow'], { cwd: LAUNCHER_DIR });
	return join(LAUNCHER_DIR, 'target', 'release', launcherName);
}

function addLauncher(path: string): void {
	if (!existsSync(path)) fail(`${path} does not exist`);
	copyFileSync(path, join(BUNDLE, launcherName));
	chmodSync(join(BUNDLE, launcherName), 0o755);
}

// ---------------------------------------------------------------------------

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });

buildApp();
copyApp();
await bundleAppEntries(APP);
installDependencies();
await addNode();
addLauncher(options.launcher ?? buildLauncher());
copyFileSync('LICENSE', join(BUNDLE, 'LICENSE'));
writeFileSync(join(BUNDLE, 'VERSION'), `${version}\n`);

mkdirSync(OUT, { recursive: true });
const outputs: string[] = [];
if (spec.zip) {
	const zip = join(OUT, WINDOWS_ZIP);
	rmSync(zip, { force: true });
	run(TAR, ['-a', '-c', '-f', zip, '-C', STAGE, 'lookstow']);
	outputs.push(zip);
}
const appArchive = join(OUT, appArchiveName(target));
rmSync(appArchive, { force: true });
// The updater's archive rules allow exactly these top-level names.
run(TAR, ['-czf', appArchive, '-C', BUNDLE, launcherName, 'node', 'app', 'VERSION', 'LICENSE']);
outputs.push(appArchive);
console.log(`release:local: Lookstow ${version} for ${platform} (Node ${nodeVersion})`);
for (const path of outputs) {
	console.log(`  ${path}`);
	console.log(`  SHA-256 ${sha256(path)}`);
}
console.log('  Sign its manifest with: npm run release:sign -- --target ' + target);
