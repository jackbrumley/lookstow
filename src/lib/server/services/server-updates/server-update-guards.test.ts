import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consoleWrite } from './guards.ts';
import { publishReady } from './readiness.ts';
import {
	CHECK_CACHE,
	REINSTALL_ONCE,
	ServerUpdates,
	SOURCE_RUN,
	UPDATE_FLAG,
	type ActivityEntry,
	UPDATE_STATUS
} from './service.ts';
import { CHANGELOG } from '#lib/domain/releases/changelog.ts';

const NOW = Date.parse('2026-11-18T00:00:00.000Z');
const TARGET = 'x86_64-unknown-linux-gnu' as const;
const release = {
	version: '0.4.1',
	notes: 'A tested update.',
	publishedAtIso: '2026-11-09T00:00:00.000Z',
	manifest: {
		schemaVersion: 1 as const,
		version: '0.4.1',
		target: TARGET,
		archive: `lookstow-app-${TARGET}.tar.gz`,
		bytes: 100,
		sha256: 'a'.repeat(64),
		minimumLauncher: '0.4.0',
		nodeMajor: 26,
		rollbackFrom: ['0.4.0']
	}
};

const folders: string[] = [];

function scratch(): string {
	const folder = mkdtempSync(join(tmpdir(), 'lookstow-update-guards-'));
	folders.push(folder);
	return folder;
}

function installed(dataDir: string) {
	return { kind: 'installed' as const, dataDir, target: TARGET, nonce: 'a'.repeat(64) };
}

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

/** An installed server at `current` whose last check found `offered`. */
async function checked(
	current: string,
	offered: typeof release
): Promise<{ service: ServerUpdates; folder: string; recorded: ActivityEntry[] }> {
	const folder = scratch();
	const recorded: ActivityEntry[] = [];
	const service = new ServerUpdates(
		installed(folder),
		current,
		() => Promise.resolve(offered),
		(entry) => recorded.push(entry)
	);
	await service.check('schedule', NOW);
	return { service, folder, recorded };
}

describe('Update now', () => {
	it('writes only the empty flag, records the request and refuses a second one', async () => {
		const { service, folder, recorded } = await checked('0.4.0', release);
		expect(service.request('0.4.1', NOW)).toEqual({ requestedAtIso: new Date(NOW).toISOString() });
		expect(readdirSync(folder).sort()).toEqual([CHECK_CACHE, UPDATE_FLAG]);
		expect(statSync(join(folder, UPDATE_FLAG)).size).toBe(0);
		expect(service.view().operation.phase).toBe('requested');
		expect(service.view().install).toEqual({
			allowed: false,
			reason: 'An update is already in progress.'
		});
		expect(recorded.map((entry) => entry.kind)).toEqual(['update-requested']);
		expect(() => service.request('0.4.1', NOW)).toThrow('already in progress');
		expect(recorded).toHaveLength(1);
	});

	it('refuses a version other than the one on offer, and a release that needs the installer', async () => {
		const offered = await checked('0.4.0', release);
		expect(() => offered.service.request('9.9.9', NOW)).toThrow();
		expect(readdirSync(offered.folder)).not.toContain(UPDATE_FLAG);

		const tooNew = await checked('0.3.3', {
			...release,
			manifest: { ...release.manifest, minimumLauncher: '0.4.0' }
		});
		expect(tooNew.service.view().install).toEqual({ allowed: false, reason: REINSTALL_ONCE });
		expect(() => tooNew.service.request('0.4.1', NOW)).toThrow(REINSTALL_ONCE);
		expect(readdirSync(tooNew.folder)).not.toContain(UPDATE_FLAG);
		expect(tooNew.recorded).toEqual([]);
	});

	it('is refused for a source run, which has no updater', async () => {
		const service = new ServerUpdates(
			{ kind: 'source' },
			'0.4.0',
			() => Promise.resolve(release),
			() => undefined
		);
		await service.check('console', NOW);
		expect(service.view().install).toEqual({ allowed: false, reason: SOURCE_RUN });
		expect(() => service.request('0.4.1', NOW)).toThrow(SOURCE_RUN);
	});

	it('shows the updater status without ever writing it', async () => {
		const { service, folder } = await checked('0.4.0', release);
		const status = {
			phase: 'rolled-back',
			from: '0.4.0',
			to: '0.4.1',
			message: 'Lookstow 0.4.1 did not report ready within 120 s.',
			atMs: NOW
		};
		writeFileSync(join(folder, UPDATE_STATUS), JSON.stringify(status));
		expect(service.view().operation).toEqual({
			phase: 'rolled-back',
			from: '0.4.0',
			to: '0.4.1',
			message: 'Lookstow 0.4.1 did not report ready within 120 s.',
			atIso: new Date(NOW).toISOString()
		});
		expect(service.view().install.allowed).toBe(true);
		expect(JSON.parse(readFileSync(join(folder, UPDATE_STATUS), 'utf8'))).toEqual(status);
	});

	it('fails loudly on a damaged status file instead of guessing', async () => {
		const { service, folder } = await checked('0.4.0', release);
		writeFileSync(join(folder, UPDATE_STATUS), '{"phase":"exploded"}');
		expect(() => service.view()).toThrow();
	});
});

describe('console writes', () => {
	const url = new URL('http://127.0.0.1:8030/api/updates/request');

	function post(target: URL, origin: string | null): Request {
		const headers = new Headers({ 'content-type': 'application/json' });
		if (origin !== null) headers.set('origin', origin);
		return new Request(target, { method: 'POST', headers, body: '{}' });
	}

	it('allows the console itself on a loopback address', () => {
		expect(consoleWrite(post(url, 'http://127.0.0.1:8030'), url)).toEqual({ kind: 'allowed' });
		const local = new URL('http://localhost:5173/api/updates');
		expect(consoleWrite(post(local, 'http://localhost:5173'), local)).toEqual({ kind: 'allowed' });
	});

	it('refuses another site, a request with no origin, and a rebound host name', () => {
		expect(consoleWrite(post(url, 'https://evil.example'), url).kind).toBe('refused');
		expect(consoleWrite(post(url, null), url).kind).toBe('refused');
		const rebound = new URL('http://evil.example:8030/api/updates/request');
		expect(consoleWrite(post(rebound, 'http://evil.example:8030'), rebound).kind).toBe('refused');
	});
});

describe('readiness file', () => {
	it('names the nonce and the version this build runs, only for an installed server', () => {
		const folder = scratch();
		publishReady({ kind: 'source' });
		publishReady(installed(folder));
		expect(JSON.parse(readFileSync(join(folder, 'ready.json'), 'utf8'))).toEqual({
			nonce: 'a'.repeat(64),
			version: CHANGELOG[0].version
		});
		expect(readdirSync(folder)).toEqual(['ready.json']);
	});
});
