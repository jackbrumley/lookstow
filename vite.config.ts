import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

const packageJson: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
if (
	typeof packageJson !== 'object' ||
	packageJson === null ||
	!('version' in packageJson) ||
	typeof packageJson.version !== 'string'
) {
	throw new Error('package.json has no version');
}

export default defineConfig({
	define: {
		// Shown at the bottom of the sidebar and compared with the latest release.
		__LOOKSTOW_VERSION__: JSON.stringify(packageJson.version)
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Runes everywhere in our code; libraries keep their own mode.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// Cross-site writes are refused by Lookstow's own origin check in hooks.server.ts,
			// which also covers JSON posts.
			csrf: { trustedOrigins: ['*'] },
			// Open pages learn of a new version within a minute (the frame offers a reload), so a
			// page left open across an update never asks for code the new build no longer has.
			version: { pollInterval: 60_000 }
		})
	],
	// The dev server answers on this computer only, like the installed service.
	server: { host: '127.0.0.1', port: 8031, strictPort: true },
	test: {
		expect: { requireAssertions: true },
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		environment: 'node',
		// Set before env.ts reads them, so tests get a fresh in-memory database.
		env: {
			DATABASE_PATH: ':memory:',
			SECRETS_KEY: Buffer.alloc(32, 1).toString('base64')
		},
		include: ['src/**/*.test.ts', 'tests/**/*.test.ts']
	}
});
