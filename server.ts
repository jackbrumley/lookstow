/**
 * Production entry point: the adapter-node handler on a Node HTTP server, listening on HOST and
 * PORT (127.0.0.1:8030 unless server.env says otherwise). Plain HTTP: the console is for this
 * computer only. `npm start` runs it from the repository; a release bundles it into
 * app/server.js (scripts/release/app-entries.ts), which the launcher runs.
 *
 * Before the app (and its migrations) loads, the server takes the lock on its database, so a
 * second server on the same data waits until the first has stopped. Nothing listens while it
 * waits, so /healthz and /readyz answer only once the lock is held and the migrations applied.
 */
import { existsSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { acquireDataLock } from './src/lib/server/database/data-lock.ts';
import { env } from './src/lib/server/env.ts';
import { publishReady } from './src/lib/server/services/server-updates/readiness.ts';

/**
 * Long enough for the old server to stop during an update (its grace period, then
 * server.close below), short enough that a forgotten second server fails visibly.
 */
const LOCK_WAIT_MS = 120_000;

// Held until the process ends (the kernel releases it however that happens);
// this module keeps the reference, so the lock's connection is never collected.
const dataLock =
	env.databasePath === ':memory:'
		? undefined
		: await acquireDataLock(env.databasePath, {
				timeoutMs: LOCK_WAIT_MS,
				retryMs: 1_000,
				log: (line) => process.stdout.write(`${line}\n`)
			});

/**
 * adapter-node takes every request as https unless told otherwise, so `url.origin` would never
 * equal the `Origin` a browser sends to http://127.0.0.1:8030 and every console write would be
 * refused as cross-site. It reads the scheme from PROTOCOL_HEADER when its handler loads; this
 * server sets that header on every request itself (overwriting anything a client sent), and
 * leaves the host as the browser addressed it (127.0.0.1 or localhost).
 */
const PROTOCOL_HEADER = 'x-lookstow-protocol';
process.env['PROTOCOL_HEADER'] = PROTOCOL_HEADER;

// The work thread's and the AI tools' entries (docs/specs/SPEC-SCALE.md): app/work.js and
// app/ai.js beside a release's server.js, or the source files in a source run.
const bundledWork = new URL('./work.js', import.meta.url);
const bundled = existsSync(bundledWork);
process.env['LOOKSTOW_WORK_ENTRY'] = fileURLToPath(
	bundled ? bundledWork : new URL('./src/lib/server/work/work-thread.ts', import.meta.url)
);
process.env['LOOKSTOW_AI_ENTRY'] = fileURLToPath(
	bundled
		? new URL('./ai.js', import.meta.url)
		: new URL('./src/lib/server/work/ai-thread.ts', import.meta.url)
);

/**
 * Which listener a request came in on, set by this server on every request (overwriting anything
 * a client sent): `local` (this computer only) or `remote` (HTTPS, docs/specs/SPEC-REMOTE.md).
 * hooks.server.ts lets a remote request in only from an allowed address, signed in, read-only.
 */
const LISTENER_HEADER = 'x-lookstow-listener';

/**
 * The remote HTTPS listener, started, changed and stopped by the app (Settings, Remote access)
 * through this control on globalThis (services/remote/listener.ts). A config the app sends while
 * this module is still loading the handler is applied once it has.
 */
type RemoteConfig = { port: number; key: string; cert: string };
let handlerRef: RequestListener | null = null;
let remote: HttpsServer | null = null;
let waitingConfig: RemoteConfig | null | undefined;

async function applyRemote(config: RemoteConfig | null): Promise<string | null> {
	if (handlerRef === null) {
		waitingConfig = config;
		return null;
	}
	const listener = handlerRef;
	const running = remote;
	if (running !== null) {
		remote = null;
		await new Promise<void>((resolve) => {
			running.close(() => {
				resolve();
			});
			running.closeAllConnections();
		});
	}
	if (config === null) return null;
	const https = createHttpsServer({ key: config.key, cert: config.cert }, (request, response) => {
		request.headers[PROTOCOL_HEADER] = 'https';
		request.headers[LISTENER_HEADER] = 'remote';
		listener(request, response);
	});
	return new Promise((resolve) => {
		https.once('error', (error) => {
			resolve(`Could not listen on port ${String(config.port)}: ${error.message}`);
		});
		https.listen(config.port, '0.0.0.0', () => {
			remote = https;
			process.stdout.write(`Lookstow remote access on https://0.0.0.0:${String(config.port)}\n`);
			resolve(null);
		});
	});
}
Reflect.set(globalThis, 'lookstow.remoteListener', { apply: applyRemote });

// Importing the handler runs the app's `init` hook (migrations, the backup engine, update checks).
const handlerModule: unknown = await import(new URL('./build/handler.js', import.meta.url).href);
/** adapter-node's handler is a (request, response) listener; a function is all JavaScript can check. */
function isRequestListener(value: unknown): value is RequestListener {
	return typeof value === 'function';
}
if (
	typeof handlerModule !== 'object' ||
	handlerModule === null ||
	!('handler' in handlerModule) ||
	!isRequestListener(handlerModule.handler)
) {
	throw new Error('build/handler.js has no handler; run npm run build first');
}
const handler = handlerModule.handler;

handlerRef = handler;
if (waitingConfig !== undefined) {
	void applyRemote(waitingConfig).then((problem) => {
		if (problem !== null) process.stderr.write(`${problem}\n`);
	});
}

const server = createServer((request, response) => {
	request.headers[PROTOCOL_HEADER] = 'http';
	request.headers[LISTENER_HEADER] = 'local';
	handler(request, response);
});
server.listen(env.port, env.host, () => {
	publishReady(env.launcher);
	const lock = dataLock === undefined ? '' : `, holding ${dataLock.path}`;
	process.stdout.write(`Lookstow listening on http://${env.host}:${String(env.port)}${lock}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		server.close();
		server.closeIdleConnections();
		void applyRemote(null);
		setTimeout(() => {
			server.closeAllConnections();
			process.exit(0);
		}, 10_000).unref();
	});
}
