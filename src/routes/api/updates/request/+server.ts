import { serverUpdateRequestSchema } from '#lib/schemas/releases/server-updates.ts';
import { consoleWrite } from '#lib/server/services/server-updates/guards.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import { backupEngine } from '#lib/server/runtime.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

function refused(status: 400 | 403 | 409, message: string): Response {
	return Response.json({ message }, { status, headers: NO_STORE });
}

/**
 * Update now: writes the empty request flag for the launcher's updater and nothing else.
 * `version` is the release the person confirmed; a different one on offer is refused.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	const allowed = consoleWrite(request, url);
	if (allowed.kind === 'refused') return refused(403, allowed.reason);
	const lockdown = backupEngine().lockdown();
	if (lockdown !== null) return refused(409, lockdown);
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return refused(400, 'The request body is not JSON.');
	}
	const parsed = serverUpdateRequestSchema.safeParse(body);
	if (!parsed.success)
		return refused(400, 'Send the version to install, as { "version": "x.y.z" }.');
	try {
		const { requestedAtIso } = serverUpdates().request(parsed.data.version, Date.now());
		return Response.json(
			{ requestedAtIso, view: serverUpdates().view() },
			{ status: 202, headers: NO_STORE }
		);
	} catch (error) {
		return refused(409, error instanceof Error ? error.message : String(error));
	}
};
