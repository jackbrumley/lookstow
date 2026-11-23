import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CHECK_CACHE,
	ServerUpdates,
	SOURCE_RUN,
	UPDATE_TIMINGS,
	type ActivityEntry
} from './service.ts';

const NOW = Date.parse('2026-11-18T00:00:00.000Z');
const release = {
	version: '0.3.1',
	notes: 'A tested update.',
	publishedAtIso: '2026-11-08T00:00:00.000Z',
	manifest: {
		schemaVersion: 1 as const,
		version: '0.3.1',
		target: 'x86_64-unknown-linux-gnu' as const,
		archive: 'lookstow-app-x86_64-unknown-linux-gnu.tar.gz',
		bytes: 100,
		sha256: 'a'.repeat(64),
		minimumLauncher: '0.3.0',
		nodeMajor: 26,
		rollbackFrom: ['0.3.0']
	}
};

const folders: string[] = [];

function scratch(): string {
	const folder = mkdtempSync(join(tmpdir(), 'lookstow-update-check-'));
	folders.push(folder);
	return folder;
}

function installed(dataDir: string) {
	return {
		kind: 'installed' as const,
		dataDir,
		target: release.manifest.target,
		nonce: 'a'.repeat(64)
	};
}

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

describe('update checks', () => {
	it('checks on demand, coalesces requests and records the last successful check', async () => {
		const recorded: ActivityEntry[] = [];
		let checks = 0;
		const service = new ServerUpdates(
			installed(scratch()),
			'0.3.0',
			() => {
				checks += 1;
				return Promise.resolve(release);
			},
			(entry) => recorded.push(entry)
		);
		await Promise.all([service.check('console', NOW), service.check('console', NOW)]);
		expect(checks).toBe(1);
		expect(service.view()).toMatchObject({
			installedVersion: '0.3.0',
			deployment: 'installed',
			release: { version: '0.3.1' },
			lastSuccessAtIso: new Date(NOW).toISOString(),
			install: { allowed: true, reason: '' },
			operation: { phase: 'idle' }
		});
		expect(recorded).toEqual([
			{
				level: 'info',
				kind: 'update-checked',
				actor: 'console',
				summary: 'Checked for updates: Lookstow 0.3.1 is available',
				detail: null
			}
		]);
	});

	it('records only checks asked for in the console, and is due again 6 hours later', async () => {
		const recorded: ActivityEntry[] = [];
		const service = new ServerUpdates(
			installed(scratch()),
			'0.3.1',
			() => Promise.resolve(null),
			(entry) => recorded.push(entry)
		);
		expect(service.due(NOW)).toBe(true);
		await service.check('schedule', NOW);
		expect(recorded).toEqual([]);
		expect(service.due(NOW + 6 * 60 * 60 * 1000 - 1)).toBe(false);
		expect(service.due(NOW + 6 * 60 * 60 * 1000)).toBe(true);
		expect(service.view().install).toEqual({
			allowed: false,
			reason: 'No newer signed release is available.'
		});
	});

	it('keeps the last check across restarts and hides a release already installed', () => {
		const folder = scratch();
		writeFileSync(
			join(folder, CHECK_CACHE),
			JSON.stringify({
				checkedAtIso: '2026-11-08T00:00:00.000Z',
				lastSuccessAtIso: '2026-11-08T00:00:00.000Z',
				release,
				problem: null
			})
		);
		const before = new ServerUpdates(
			installed(folder),
			'0.3.0',
			() => Promise.resolve(null),
			() => undefined
		);
		expect(before.view().release?.version).toBe('0.3.1');
		const after = new ServerUpdates(
			installed(folder),
			'0.3.1',
			() => Promise.resolve(null),
			() => undefined
		);
		expect(after.view().release).toBeNull();
		expect(after.view().install.allowed).toBe(false);
	});

	it('shows when each step of the last update ended, and nothing for a damaged record', () => {
		const folder = scratch();
		const service = new ServerUpdates(
			installed(folder),
			'0.3.0',
			() => Promise.resolve(null),
			() => undefined
		);
		expect(service.view().lastUpdateSteps).toEqual([]);
		writeFileSync(
			join(folder, UPDATE_TIMINGS),
			JSON.stringify({
				steps: [
					{ step: 'requested', atMs: NOW },
					{ step: 'ready', atMs: NOW + 30_000 }
				]
			})
		);
		expect(service.view().lastUpdateSteps).toEqual([
			{ step: 'requested', atIso: new Date(NOW).toISOString() },
			{ step: 'ready', atIso: new Date(NOW + 30_000).toISOString() }
		]);
		writeFileSync(join(folder, UPDATE_TIMINGS), '{"steps": [');
		expect(service.view().lastUpdateSteps).toEqual([]);
	});

	it('does not claim that no update exists when the latest check failed', async () => {
		const recorded: ActivityEntry[] = [];
		const service = new ServerUpdates(
			installed(scratch()),
			'0.3.0',
			() => Promise.reject(new Error('Update check returned HTTP 504.')),
			(entry) => recorded.push(entry)
		);
		await service.check('console', NOW);
		expect(service.due(NOW + 5 * 60 * 1000 - 1)).toBe(false);
		expect(service.due(NOW + 5 * 60 * 1000)).toBe(true);
		expect(service.view()).toMatchObject({
			problem: 'Update check returned HTTP 504.',
			install: {
				allowed: false,
				reason:
					'Could not confirm whether a newer signed release is available. Check for updates again.'
			}
		});
		expect(recorded[0]).toMatchObject({ level: 'warn', detail: 'Update check returned HTTP 504.' });
	});

	it('shows a release to a source run but never offers to install it', async () => {
		const service = new ServerUpdates(
			{ kind: 'source' },
			'0.3.0',
			() => Promise.resolve(release),
			() => undefined
		);
		await service.check('schedule', NOW);
		expect(service.view()).toMatchObject({
			deployment: 'source',
			release: { version: '0.3.1' },
			install: { allowed: false, reason: SOURCE_RUN }
		});
	});
});
