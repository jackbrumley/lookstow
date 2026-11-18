import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	download,
	newestRelease,
	RELEASE_PUBLIC_KEY,
	REPOSITORY,
	SERVER_SIGNING_DOMAIN,
	verifyManifest
} from './release.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const manifest = {
	schemaVersion: 1,
	version: '0.3.1',
	target: 'x86_64-unknown-linux-gnu',
	archive: 'lookstow-app-x86_64-unknown-linux-gnu.tar.gz',
	bytes: 100,
	sha256: 'a'.repeat(64),
	minimumLauncher: '0.3.0',
	nodeMajor: 26,
	rollbackFrom: ['0.3.0']
};

afterEach(() => {
	vi.unstubAllGlobals();
});

function response(status: number, body = ''): Response {
	const result = new Response(body, { status });
	Object.defineProperty(result, 'url', { value: 'https://api.github.com/releases/latest' });
	return result;
}

function signedEnvelope(payloadObject: object): { payload: string; signature: string } {
	const payload = Buffer.from(JSON.stringify(payloadObject));
	return {
		payload: payload.toString('base64'),
		signature: sign(
			null,
			Buffer.concat([Buffer.from(SERVER_SIGNING_DOMAIN), payload]),
			privateKey
		).toString('base64')
	};
}

function signed(): Buffer {
	return Buffer.from(JSON.stringify(signedEnvelope(manifest)));
}

describe('signed stable releases', () => {
	it('uses the same public key as the launcher', () => {
		expect(RELEASE_PUBLIC_KEY).toBe(
			readFileSync('launcher/crates/lookstow/release-key.pub', 'utf8').trim()
		);
	});

	it('uses the launcher signing domain', () => {
		expect(readFileSync('launcher/crates/lookstow/src/updates/manifest.rs', 'utf8')).toContain(
			`b"${SERVER_SIGNING_DOMAIN.trim()}\\n"`
		);
	});

	it('rejects unsigned, tampered and misnamed manifests', () => {
		expect(verifyManifest(signed(), key).version).toBe('0.3.1');
		expect(() => verifyManifest(signed(), RELEASE_PUBLIC_KEY)).toThrow('signature');
		const changed = {
			...signedEnvelope(manifest),
			payload: Buffer.from(JSON.stringify({ ...manifest, bytes: 101 })).toString('base64')
		};
		expect(() => verifyManifest(Buffer.from(JSON.stringify(changed)), key)).toThrow('signature');
		const misnamed = signedEnvelope({ ...manifest, archive: 'other.tar.gz' });
		expect(() => verifyManifest(Buffer.from(JSON.stringify(misnamed)), key)).toThrow(
			'archive name'
		);
	});

	it('ignores older versions and validates platform assets', async () => {
		const metadata = Buffer.from(
			JSON.stringify({
				tag_name: 'v0.3.1',
				draft: false,
				prerelease: false,
				body: 'Changes',
				published_at: '2026-11-08T00:00:00Z',
				assets: [
					{ name: `lookstow-app-${manifest.target}.json`, size: signed().length },
					{ name: manifest.archive, size: 100 }
				]
			})
		);
		const get = (url: string) =>
			Promise.resolve(url.includes('api.github.com') ? metadata : signed());
		expect(await newestRelease('0.3.1', 'x86_64-unknown-linux-gnu', get, key)).toBeNull();
		expect((await newestRelease('0.3.0', 'x86_64-unknown-linux-gnu', get, key))?.version).toBe(
			'0.3.1'
		);
		await expect(newestRelease('0.3.0', 'x86_64-pc-windows-msvc', get, key)).rejects.toThrow(
			'manifest'
		);
	});

	it('never offers a pre-release, however new', async () => {
		const asked: string[] = [];
		const reply = (tag: string, prerelease: boolean) => (url: string) => {
			asked.push(url);
			return Promise.resolve(
				Buffer.from(
					JSON.stringify({
						tag_name: tag,
						draft: false,
						prerelease,
						body: '',
						published_at: '2026-11-11T00:00:00Z',
						assets: [{ name: `lookstow-app-${manifest.target}.json`, size: 100 }]
					})
				)
			);
		};
		await expect(
			newestRelease('0.3.0', 'x86_64-unknown-linux-gnu', reply('v9.0.0-rc.1', true), key)
		).rejects.toThrow('non-stable');
		await expect(
			newestRelease('0.3.0', 'x86_64-unknown-linux-gnu', reply('v9.0.0-rc.1', false), key)
		).rejects.toThrow();
		expect(new Set(asked)).toEqual(
			new Set([`https://api.github.com/repos/${REPOSITORY}/releases/latest`])
		);
	});

	it('retries transient GitHub gateway failures and returns the successful response', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(504, 'gateway timeout'))
			.mockResolvedValueOnce(response(200, 'release metadata'));
		vi.stubGlobal('fetch', fetchMock);
		await expect(download('https://api.github.com/releases/latest', 256 * 1024)).resolves.toEqual(
			Buffer.from('release metadata')
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('stops after the bounded retry budget for persistent gateway failures', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(504, 'gateway timeout'));
		vi.stubGlobal('fetch', fetchMock);
		await expect(download('https://api.github.com/releases/latest', 256 * 1024)).rejects.toThrow(
			'HTTP 504'
		);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('does not retry non-transient HTTP errors, and refuses an oversized body', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(404, 'not found'));
		vi.stubGlobal('fetch', fetchMock);
		await expect(download('https://api.github.com/releases/latest', 256 * 1024)).rejects.toThrow(
			'HTTP 404'
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(200, 'x'.repeat(20))));
		await expect(download('https://api.github.com/releases/latest', 10)).rejects.toThrow(
			'size limit'
		);
	});
});
