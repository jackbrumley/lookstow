import type { ActivityLevel } from '../../../domain/activity.ts';
import type { EmailSource } from './email-content.ts';

/**
 * Which activity entries are worth an email, and to whom (by alert type). The activity log is
 * already the one record of everything that happens, so alerts follow it rather than every part
 * of Lookstow sending email itself. Anything not listed here sends nothing.
 */
export type AlertableActivity = {
	level: ActivityLevel;
	kind: string;
	actor: string;
	summary: string;
	detail: string | null;
};

function body(entry: AlertableActivity, next: string): string {
	return [entry.summary, entry.detail ?? '', next].filter((part) => part !== '').join('\n\n');
}

export function alertFor(entry: AlertableActivity): EmailSource | null {
	const system = entry.actor === 'system';
	switch (entry.kind) {
		case 'sync':
			// A mailbox starting to fail, or syncing again; not "Sync now was asked for".
			if (!system) return null;
			return {
				alert: 'mailbox-problems',
				title: entry.summary,
				body: body(
					entry,
					entry.level === 'error'
						? 'Lookstow tries again at the mailbox’s next sync. It emails again when the mailbox syncs again, not at every failed try.'
						: 'Nothing more to do.'
				),
				page: 'Mailboxes'
			};
		case 'discovery':
			if (entry.level !== 'error') return null;
			return {
				alert: 'discovery-problems',
				title: entry.summary,
				body: body(
					entry,
					'Mailboxes already found keep backing up. New mailboxes are found once discovery works again.'
				),
				page: 'Activity'
			};
		case 'pause':
			// The disk guard pauses as the system; a person pausing in the console is not an alert.
			if (!system) return null;
			return {
				alert: 'disk',
				title: entry.summary,
				body: body(
					entry,
					'Free space on the backup drive, or raise the limit in Settings > Disk space, then press Resume.'
				),
				page: 'Dashboard'
			};
		case 'completeness':
			// The re-read from the start is routine; only a difference that outlasts it is news.
			if (entry.level !== 'error') return null;
			return {
				alert: 'completeness',
				title: entry.summary,
				body: body(
					entry,
					'Lookstow keeps syncing the mailbox and emails again only if another folder starts to differ for a day.'
				),
				page: 'Mailboxes'
			};
		case 'index-snapshot':
			return {
				alert: 'index-snapshot',
				title: entry.summary,
				body: body(
					entry,
					'Check that the backup drive is connected and has space. Lookstow tries again every hour and says nothing more until a copy succeeds.'
				),
				page: 'Dashboard'
			};
		case 'mailbox-found':
		case 'mailbox-gone':
			return {
				alert: 'mailboxes-changed',
				title: entry.summary,
				body: body(entry, 'A mailbox that is gone keeps its backup.'),
				page: 'Mailboxes'
			};
		case 'first-copy':
			return {
				alert: 'first-copy',
				title: entry.summary,
				body: body(entry, ''),
				page: 'Mailboxes'
			};
		case 'backup-deleted':
		case 'mailbox-scope':
			return {
				alert: 'backups-deleted',
				title: entry.summary,
				body: body(entry, `Done in the console by ${entry.actor}.`),
				page: 'Activity'
			};
		case 'update-requested':
			if (!system) return null;
			return {
				alert: 'updates',
				title: entry.summary,
				body: body(
					entry,
					'Backups pause for about three minutes while Lookstow restarts. If the new version does not start, the updater puts the old one back.'
				),
				page: 'Updates'
			};
		default:
			return null;
	}
}
