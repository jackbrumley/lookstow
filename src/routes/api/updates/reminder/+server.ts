import { z } from 'zod';
import type { RequestHandler } from './$types';
import { database } from '#lib/server/runtime.ts';
import { consoleWrite } from '#lib/server/services/server-updates/guards.ts';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import { readUpdateReminder, saveUpdateReminder } from '#lib/server/services/settings/settings.ts';
import { REMIND_AGAIN_MS } from '#lib/domain/releases/update-reminder.ts';

const NO_STORE = { 'cache-control': 'no-store' };

const answerSchema = z.strictObject({
	answer: z.enum(['later', 'skip']),
	version: z.string().max(40)
});

/**
 * The update reminder's answer: "later" hides it for a day, "skip" until a newer release than
 * `version` is offered. Kept on the server, so every browser follows it.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	const allowed = consoleWrite(request, url);
	if (allowed.kind === 'refused') {
		return Response.json({ message: allowed.reason }, { status: 403, headers: NO_STORE });
	}
	const parsed = answerSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return Response.json(
			{ message: 'Send { "answer": "later" | "skip", "version": "x.y.z" }.' },
			{ status: 400, headers: NO_STORE }
		);
	}
	const { answer, version } = parsed.data;
	const current = readUpdateReminder(database);
	saveUpdateReminder(
		database,
		answer === 'later'
			? { ...current, snoozedUntil: new Date(Date.now() + REMIND_AGAIN_MS).toISOString() }
			: { ...current, skippedVersion: version }
	);
	recordActivity(database, {
		level: 'info',
		kind: 'updates',
		actor: 'console',
		summary:
			answer === 'later'
				? `The reminder about Lookstow ${version} was put off for a day`
				: `Lookstow ${version} was skipped; newer releases are still offered`
	});
	return Response.json(
		{ message: answer === 'later' ? 'Reminding you tomorrow.' : `Skipping ${version}.` },
		{ headers: NO_STORE }
	);
};
