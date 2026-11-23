// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	/** package.json's version, put in by Vite at build time (vite.config.ts). */
	const __LOOKSTOW_VERSION__: string;

	namespace App {
		interface Locals {
			/** The request came from this computer (the console answers nobody else yet). */
			isLocal: boolean;
			/**
			 * The signed-in remote account's name on the remote listener (docs/specs/SPEC-REMOTE.md),
			 * or null: on this computer, or not signed in yet. A remote person only reads.
			 */
			remoteUser: string | null;
		}
	}
}

export {};
