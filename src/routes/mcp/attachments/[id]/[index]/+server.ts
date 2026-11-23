import type { RequestHandler } from './$types';
import { aiTools, database } from '#lib/server/runtime.ts';
import { aiCaller } from '#lib/server/services/ai/access.ts';

/** GET /mcp/attachments/{messageId}/{index}: one attachment's bytes, for AI tools (token needed). */
export const GET: RequestHandler = async ({ request, params, url, locals }) => {
	const allowed = aiCaller(database, locals, request.headers.get('authorization'));
	if (!allowed.ok) return new Response(allowed.reason, { status: allowed.status });
	const index = Number.parseInt(params.index, 10);
	if (!Number.isInteger(index) || index < 0) return new Response('Bad index', { status: 400 });
	const found = await aiTools().attachment(params.id, index, url.origin, allowed.who);
	if ('error' in found) return new Response(found.error, { status: 404 });
	const ascii = found.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return new Response(new Uint8Array(found.data), {
		headers: {
			'content-type': found.contentType,
			'content-length': String(found.data.length),
			'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(found.filename)}`,
			'cache-control': 'no-store'
		}
	});
};
