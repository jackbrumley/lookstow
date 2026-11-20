/**
 * The Node entry points in a release bundle's app/ folder: server.ts bundled into app/server.js,
 * and the work thread (docs/specs/SPEC-SCALE.md) into app/work.js, as ES modules with every library inlined except better-sqlite3 (native code, the only
 * package the bundle ships in node_modules). The launcher runs it as the service
 * (launcher/crates/lookstow/src/launcher.rs); app/build/ beside it is the adapter-node output
 * it imports.
 */
import { build } from 'vite';
import { packageVersion } from './targets.ts';

const APP_ENTRIES = { server: 'server.ts', work: 'src/lib/server/work/work-thread.ts' } as const;

/** Bundles every entry into `outDir` as `<name>.js`; shared code would go to chunks/. */
export async function bundleAppEntries(outDir: string): Promise<void> {
	await build({
		configFile: false,
		logLevel: 'warn',
		// The same constant the SvelteKit build defines (src/lib/utils/app-version.ts).
		define: { __LOOKSTOW_VERSION__: JSON.stringify(packageVersion()) },
		ssr: { noExternal: true, external: ['better-sqlite3'] },
		build: {
			ssr: true,
			outDir,
			emptyOutDir: false,
			target: 'node26',
			minify: false,
			rolldownOptions: {
				input: APP_ENTRIES,
				output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' }
			}
		}
	});
}
