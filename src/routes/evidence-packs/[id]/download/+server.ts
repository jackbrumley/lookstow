import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { database, dataDir } from '#lib/server/runtime.ts';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import { packDownload } from '#lib/server/services/evidence/download.ts';

/**
 * GET /evidence-packs/{id}/download: a finished pack's ZIP (docs/specs/SPEC-EVIDENCE-PACKS.md),
 * resumable. A download from the start goes to the activity log, with who and from where.
 */
export const GET: RequestHandler = async ({ params, request, locals, getClientAddress }) => {
	const found = await packDownload(dataDir(), params.id, request).catch(() => null);
	if (found === null) error(404, 'No finished evidence pack with that id');
	if (found.response.status === 200) {
		const person = locals.isLocal ? 'console' : (locals.remoteUser ?? 'remote');
		recordActivity(database, {
			level: 'info',
			kind: 'evidence-pack',
			actor: person,
			summary: `Evidence pack downloaded: ${found.name}`,
			detail: `By ${person} from ${getClientAddress()}.`
		});
	}
	return found.response;
};
