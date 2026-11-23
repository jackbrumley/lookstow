import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';
import { showsUpdateNotice } from './server-update-notice.ts';

/**
 * The update reminder (docs/specs/SPEC-INSTALL-AND-UPDATES.md): when a newer release is offered,
 * every page shows it front and centre until someone answers. "Remind me tomorrow" hides it for
 * a day, "Skip this version" until a newer one comes out. The answer is kept on the server, so
 * a second browser is not asked again the same day.
 */
export type UpdateReminderState = {
	/** No reminder before this time (ISO). */
	snoozedUntil: string | null;
	/** This release is not offered again; a newer one is. */
	skippedVersion: string | null;
};

export const REMIND_AGAIN_MS = 24 * 60 * 60 * 1000;

export type UpdateOffer = {
	version: string;
	installed: string;
	/** The first lines of its release notes, as plain text. */
	highlights: string[];
	/** Whether the reminder shows now (else only the sidebar's badge does). */
	remind: boolean;
};

/** The first few lines of a release's notes, without Markdown marks. */
export function highlightsOf(notes: string, most = 5): string[] {
	return notes
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(/^\s*(?:#+|[-*]|\d+\.)\s*/, '')
				.replace(/\*\*|__|`/g, '')
				.trim()
		)
		.filter((line) => line !== '')
		.slice(0, most);
}

/**
 * The offer to show, or null when there is none: no newer release, or one being installed now.
 * `remind` is false on the Updates page, while the backup moves, after a snooze or a skip.
 */
export function updateOffer(
	view: ServerUpdateView | null,
	page: 'updates' | 'other',
	reminder: UpdateReminderState,
	lockedDown: boolean,
	now: number
): UpdateOffer | null {
	if (!showsUpdateNotice(view, 'other')) return null;
	const version = view.release.version;
	const snoozed = reminder.snoozedUntil !== null && Date.parse(reminder.snoozedUntil) > now;
	return {
		version,
		installed: view.installedVersion,
		highlights: highlightsOf(view.release.notes),
		remind: page === 'other' && !lockedDown && !snoozed && reminder.skippedVersion !== version
	};
}
