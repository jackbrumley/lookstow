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
import { createServer, type RequestListener } from 'node:http';
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

// Importing the handler runs the app's `init` hook (migrations, the backup engine, update checks).
const handlerModule: unknown = await import(new URL('./build/handler.js', import.meta.url).href);
if (
	typeof handlerModule !== 'object' ||
	handlerModule === null ||
	!('handler' in handlerModule) ||
	typeof handlerModule.handler !== 'function'
) {
	throw new Error('build/handler.js has no handler; run npm run build first');
}
const handler = handlerModule.handler as RequestListener;

const server = createServer((request, response) => {
	request.headers[PROTOCOL_HEADER] = 'http';
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
		setTimeout(() => {
			server.closeAllConnections();
			process.exit(0);
		}, 10_000).unref();
	});
}
