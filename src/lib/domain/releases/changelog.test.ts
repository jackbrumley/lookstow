import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANGELOG, type Release } from './changelog.ts';
import { compareVersions, isStableVersion } from './version.ts';

function packageVersion(): unknown {
	const parsed: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
	return typeof parsed === 'object' && parsed !== null && 'version' in parsed
		? parsed.version
		: undefined;
}

describe('the changelog', () => {
	it('starts with the version in package.json, which is the version this build runs', () => {
		expect(CHANGELOG[0].version).toBe(packageVersion());
	});

	it('lists each release once, newest first, with what to test on real machines', () => {
		const versions = CHANGELOG.map((entry) => entry.version);
		expect(versions.every(isStableVersion)).toBe(true);
		expect(new Set(versions).size).toBe(versions.length);
		for (let index = 1; index < versions.length; index += 1) {
			expect(compareVersions(versions[index - 1] ?? '', versions[index] ?? '')).toBe(1);
		}
		const entries: readonly Release[] = CHANGELOG;
		for (const entry of entries) {
			expect(entry.testing.kind === 'none' || entry.testing.steps.length > 0).toBe(true);
			expect(entry.changes.length).toBeGreaterThan(0);
		}
	});
});

describe('release versions', () => {
	it('compares x.y.z numerically and refuses anything else', () => {
		expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
		expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
		expect(isStableVersion('1.2.3-rc.1')).toBe(false);
		expect(isStableVersion('01.2.3')).toBe(false);
		expect(() => compareVersions('v1.2.3', '1.2.3')).toThrow('not a release version');
	});
});
