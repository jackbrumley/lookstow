/**
 * The Node entry points in a release bundle's app/ folder: server.ts bundled into app/server.js,
 * and the work thread (docs/specs/SPEC-SCALE.md) into app/work.js, as ES modules with every library inlined except better-sqlite3 (native code, the only
 * package the bundle ships in node_modules). The launcher runs it as the service
 * (launcher/crates/lookstow/src/launcher.rs); app/build/ beside it is the adapter-node output
 * it imports.
 */
import { build } from 'vite';
import { packageVersion } from './targets.ts';

const APP_ENTRIES = {
	server: 'server.ts',
	work: 'src/lib/server/work/work-thread.ts',
	ai: 'src/lib/server/work/ai-thread.ts'
} as const;

/**
 * CommonJS code bundled into these ES modules may read `__dirname`, which ES modules lack:
 * libheif-js (HEIC photos in the viewer) does, though its WebAssembly is inline and it reads no
 * file. Each bundle defines it as its own folder.
 */
const COMMONJS_DIRNAME = [
	"import { dirname as lookstowDirname } from 'node:path';",
	"import { fileURLToPath as lookstowFilePath } from 'node:url';",
	'const __dirname = lookstowDirname(lookstowFilePath(import.meta.url));'
].join('\n');

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
				output: {
					entryFileNames: '[name].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
					banner: COMMONJS_DIRNAME
				}
			}
		}
	});
}
