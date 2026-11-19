import { building } from '$app/env';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { alertService, backupEngine, database, dataDir } from '#lib/server/runtime.ts';
import { startThroughputMonitor } from '#lib/server/services/throughput/monitor.ts';
import { throughputExtras } from '#lib/server/services/throughput/extras.ts';
import { startAutomaticUpdates } from '#lib/server/services/engine/auto-update.ts';
import { pruneActivity } from '#lib/server/services/activity/activity.ts';
import { errorText, serverLog } from '#lib/server/log.ts';
import { serverUpdates, startUpdateChecks } from '#lib/server/services/server-updates/live.ts';

/**
 * Start-up and every request. At start-up the database is already open and migrated (runtime
 * imports it), the throughput governor starts from the pace it learned before (before any Graph
 * request), email alerts start listening (before anything can record activity), the backup
 * engine starts its timer, the daily release check starts, and so do
 * automatic updates (when they are on in Settings).
 *
 * Access: the console answers only on this computer. Anyone who can open a browser on the
 * server is already trusted with it; reaching it from another computer needs sign-in, which
 * is not built yet (docs/TODO.md), so it is refused rather than left open.
 */
export const init: ServerInit = () => {
	if (building) {
		return;
	}
	const throughput = startThroughputMonitor(database, dataDir(), () =>
		throughputExtras(backupEngine().status())
	);
	alertService().start();
	backupEngine().start();
	startUpdateChecks();
	startAutomaticUpdates(database, serverUpdates);
	// The activity log keeps 90 days (the Activity page says so).
	const prune = (): void => {
		pruneActivity(database, ACTIVITY_DAYS);
	};
	prune();
	setInterval(prune, 24 * 60 * 60 * 1000).unref();
	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.once(signal, () => {
			void backupEngine()
				.stop()
				.then(() => throughput.stop());
		});
	}
	serverLog('info', 'startup', `Lookstow ${__LOOKSTOW_VERSION__} started`);
};

const ACTIVITY_DAYS = 90;

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
	event.locals.isLocal = LOCAL.has(address);
	if (!event.locals.isLocal && !OPEN_PATHS.has(event.url.pathname)) {
		return new Response(
			'Lookstow answers only on the computer it runs on. Open http://localhost:8030 there.',
			{ status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
		);
	}
	// AI tools (MCP clients) send no Origin; the access token protects /mcp instead.
	const aiTool = event.url.pathname === '/mcp' && event.request.headers.get('origin') === null;
	if (!aiTool && crossSiteWrite(event.request)) {
		return new Response('Cross-site requests are refused', { status: 403 });
	}
	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	return response;
};

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
