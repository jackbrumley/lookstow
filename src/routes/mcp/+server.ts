import type { RequestHandler } from './$types';
import { backupEngine, database } from '#lib/server/runtime.ts';
import { authoriseAi } from '#lib/server/services/ai/access.ts';

/**
 * POST /mcp: the Model Context Protocol endpoint for AI tools (Streamable HTTP, JSON replies).
 * Only on this computer, only when turned on in Settings, and only with the access token. The
 * tools run on the work thread, one call at a time, so a busy AI tool never holds the console.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	const allowed = authoriseAi(database, request.headers.get('authorization'));
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
	const reply = await backupEngine().mcp(message, url.origin);
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
