import type { RequestHandler } from './$types';
import { backupEngine } from '#lib/server/runtime.ts';

/**
 * Pause and Resume, from the button in the page frame: POST {"action":"pause"|"resume"}. JSON
 * so the frame's button works from any page; the origin check in hooks.server.ts covers it.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body: unknown = await request.json().catch(() => null);
	const action =
		typeof body === 'object' && body !== null && 'action' in body ? body.action : undefined;
	try {
		if (action === 'pause') {
			backupEngine().pause('manual', 'console');
			return Response.json({ message: 'Paused. Running syncs stop after their current page.' });
		}
		if (action === 'resume') {
			backupEngine().resume('console');
			return Response.json({ message: 'Resumed.' });
		}
		return Response.json(
			{ message: 'Send {"action":"pause"} or {"action":"resume"}.' },
			{ status: 400 }
		);
	} catch (error) {
		return Response.json(
			{ message: error instanceof Error ? error.message : String(error) },
			{ status: 409 }
		);
	}
};
