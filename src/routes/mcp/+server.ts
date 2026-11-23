import type { RequestHandler } from './$types';
import { aiTools, database } from '#lib/server/runtime.ts';
import { aiCaller } from '#lib/server/services/ai/access.ts';

/**
 * POST /mcp: the Model Context Protocol endpoint for AI tools (Streamable HTTP, JSON replies).
 * On this computer when turned on in Settings, with the access token; on the remote address with
 * a remote account's own AI token (docs/specs/SPEC-REMOTE.md). The
 * tools run on their own thread, one call at a time, so a busy AI agent never holds the console
 * or the backup engine.
 */
export const POST: RequestHandler = async ({ request, url, locals }) => {
	const allowed = aiCaller(database, locals, request.headers.get('authorization'));
	if (!allowed.ok) {
		return Response.json(
			{ jsonrpc: '2.0', id: null, error: { code: -32001, message: allowed.reason } },
			{ status: allowed.status }
		);
	}
	let message: unknown;
	try {
		message = await request.json();
	} catch {
		return Response.json(
			{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'The request is not JSON' } },
			{ status: 400 }
		);
	}
	const reply = await aiTools().mcp(message, url.origin, allowed.who);
	if (reply.body === null) return new Response(null, { status: reply.status });
	return Response.json(reply.body, {
		status: reply.status,
		headers: { 'cache-control': 'no-store' }
	});
};

/** No server-sent stream: every answer comes back on its POST. */
export const GET: RequestHandler = () =>
	new Response('Lookstow answers MCP requests by POST only.', {
		status: 405,
		headers: { allow: 'POST' }
	});
