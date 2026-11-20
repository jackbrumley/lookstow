import { workerData } from 'node:worker_threads';

/**
 * A release bundles the work thread with the version written in; a source run has no build step
 * for it, so the web thread passes the version, set here before anything that reads it loads
 * (work-thread.ts imports this first).
 */
const given: unknown = workerData;
const version: unknown =
	typeof given === 'object' && given !== null && 'version' in given ? given.version : undefined;
if (!('__LOOKSTOW_VERSION__' in globalThis) && typeof version === 'string') {
	Object.assign(globalThis, { __LOOKSTOW_VERSION__: version });
}
