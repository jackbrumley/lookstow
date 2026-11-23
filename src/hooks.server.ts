import { building } from '$app/env';
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { env } from '#lib/server/env.ts';
import { aiTools, database, dataDir, startWork } from '#lib/server/runtime.ts';
import { remoteGate } from '#lib/server/services/remote/gate.ts';
import { applyRemote, auditRemote } from '#lib/server/services/remote/listener.ts';
import { startAutomaticUpdates } from '#lib/server/services/engine/auto-update.ts';
import { errorText, serverLog } from '#lib/server/log.ts';
import { serverUpdates, startUpdateChecks } from '#lib/server/services/server-updates/live.ts';
import { watchThread } from '#lib/server/work/thread-health.ts';

/**
 * Start-up and every request. At start-up the database is already open and migrated (runtime
 * imports it). The work thread starts (docs/specs/SPEC-SCALE.md): the backup engine, email
 * alerts, the throughput monitor, the indexes and the AI tools run there, so this thread only
 * answers the console. The daily release check starts here, and so do automatic updates (when
 * they are on in Settings).
 *
 * Access: the plain-HTTP console answers only on this computer; anyone who can open a browser
 * on the server is already trusted with it. Other computers come in only through the remote
 * HTTPS listener (docs/specs/SPEC-REMOTE.md): an allowed address, a signed-in account, and
 * read-only pages, every request written to the audit trail.
 */
const LISTENER_HEADER = 'x-lookstow-listener';
export const init: ServerInit = async () => {
	if (building) {
		return;
	}
	watchThread('web');
	const work = await startWork();
	startUpdateChecks();
	startAutomaticUpdates(database, serverUpdates);
	void applyRemote(database, env.secretsKey);
	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.once(signal, () => {
			void Promise.all([work.stop(), aiTools().stop()]);
		});
	}
	serverLog('info', 'startup', `Lookstow ${__LOOKSTOW_VERSION__} started`);
};

/** A request slower than this is logged with its path, so a slow page names itself. */
const SLOW_REQUEST_MS = 2_000;

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Probes the launcher and installers use; they carry nothing secret. */
const OPEN_PATHS = new Set(['/healthz', '/readyz']);

export const handle: Handle = async ({ event, resolve }) => {
	let address = '';
	try {
		address = event.getClientAddress();
	} catch {
		// No client address while prerendering: treated as not local.
	}
	event.locals.remoteUser = null;
	// server.ts marks which listener a request came in on (it overwrites what a client sends).
	if (event.request.headers.get(LISTENER_HEADER) === 'remote') {
		event.locals.isLocal = false;
		const refused = remoteGate(database, event, address);
		const response = refused ?? (await answer(event, resolve));
		audit(event, address, response.status);
		return response;
	}
	event.locals.isLocal = LOCAL.has(address);
	if (!event.locals.isLocal && !OPEN_PATHS.has(event.url.pathname)) {
		return new Response(
			'Lookstow answers only on the computer it runs on. Open http://localhost:8030 there, or use remote access (Settings) over HTTPS.',
			{ status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
		);
	}
	return answer(event, resolve);
};

/** Remote requests go to the audit trail, except the app's own files and page data fetches. */
function audit(event: RequestEvent, address: string, status: number): void {
	const path = event.url.pathname;
	// A page's data fetch is the same view as the page (SvelteKit takes /__data.json off the path).
	if (event.isDataRequest || path.startsWith('/_app/') || path === '/favicon.svg') return;
	void auditRemote(dataDir(), {
		at: new Date().toISOString(),
		user: event.locals.remoteUser,
		address,
		method: event.request.method,
		path,
		status
	});
}

async function answer(
	event: RequestEvent,
	resolve: Parameters<Handle>[0]['resolve']
): Promise<Response> {
	// AI tools (MCP clients) send no Origin; the access token protects /mcp instead.
	const aiTool = event.url.pathname === '/mcp' && event.request.headers.get('origin') === null;
	if (!aiTool && crossSiteWrite(event.request)) {
		return new Response('Cross-site requests are refused', { status: 403 });
	}
	const started = performance.now();
	const response = await resolve(event);
	const ms = performance.now() - started;
	if (ms >= SLOW_REQUEST_MS) {
		serverLog(
			'warn',
			'slow-request',
			`${event.request.method} ${event.url.pathname} took ${String(Math.round(ms))} ms`
		);
	}
	// Never framed, except the viewer's message body, which says SAMEORIGIN itself.
	if (!response.headers.has('X-Frame-Options')) response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	return response;
}

/**
 * Any write must come from a page Lookstow served: the browser's Origin has to match the host
 * the request went to. Stops another site in the same browser from posting to the console.
 */
function crossSiteWrite(request: Request): boolean {
	if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
		return false;
	}
	const origin = request.headers.get('origin');
	const host = request.headers.get('host');
	if (origin === null || host === null) {
		return true;
	}
	try {
		return new URL(origin).host !== host;
	} catch {
		return true;
	}
}

/**
 * Only unknown errors (a bug, or something the code did not expect) go to the log. Not-found
 * pages and refused requests are SvelteKit's own and ordinary.
 */
export const handleError: HandleServerError = (caught) => {
	if (caught.kind === 'unknown') {
		serverLog('error', 'request', `${caught.event.url.pathname}: ${errorText(caught.error)}`);
		return {
			message: caught.error instanceof Error ? caught.error.message : 'Something went wrong'
		};
	}
	return undefined;
};
