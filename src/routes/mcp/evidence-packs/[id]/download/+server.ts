import type { RequestHandler } from './$types';
import { database, dataDir } from '#lib/server/runtime.ts';
import { aiCaller } from '#lib/server/services/ai/access.ts';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import { packDownload } from '#lib/server/services/evidence/download.ts';

/**
 * GET /mcp/evidence-packs/{id}/download: a finished evidence pack's ZIP for AI tools, with the
 * same access token as /mcp (docs/specs/SPEC-EVIDENCE-PACKS.md). Resumable.
 */
export const GET: RequestHandler = async ({ params, request, locals }) => {
	const allowed = aiCaller(database, locals, request.headers.get('authorization'));
	if (!allowed.ok) return new Response(allowed.reason, { status: allowed.status });
	const found = await packDownload(dataDir(), params.id, request).catch(() => null);
	if (found === null)
		return new Response('No finished evidence pack with that id', { status: 404 });
	if (found.response.status === 200) {
		recordActivity(database, {
			level: 'info',
			kind: 'evidence-pack',
			actor: allowed.who === 'this computer' ? 'AI agent' : `AI agent (${allowed.who})`,
			summary: `Evidence pack downloaded: ${found.name}`,
			detail: `By an AI agent with ${allowed.who === 'this computer' ? 'the access token' : `${allowed.who}'s AI token`}.`
		});
	}
	return found.response;
};
