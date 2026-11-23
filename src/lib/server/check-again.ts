import { done } from './actions.ts';
import { backupEngine, database } from './runtime.ts';
import { recordActivity } from './services/activity/activity.ts';
import { recheckNow } from './services/mailboxes/completeness.ts';
import type { MailboxRow } from './services/mailboxes/repository.ts';

/**
 * Check again now (the dashboard's Needs attention and a mailbox's page): the mailbox's folders
 * that differ from Microsoft are read again from the start on a sync that starts now, instead of
 * waiting for their daily re-read.
 */
export function checkAgainNow(mailbox: MailboxRow) {
	const folders = recheckNow(database, mailbox.id);
	backupEngine().requestSync([mailbox.id]);
	const name = `${mailbox.address}${mailbox.kind === 'archive' ? ' (online archive)' : ''}`;
	recordActivity(database, {
		level: 'info',
		kind: 'completeness',
		actor: 'console',
		summary: `Check again now: ${name}`,
		detail: `${String(folders)} folders are read again from the start on the sync starting now.`,
		mailboxId: mailbox.id
	});
	return done(
		`Checking ${name} again now: ${String(folders)} folders are read again from the start. The result shows here when that sync ends.`
	);
}
