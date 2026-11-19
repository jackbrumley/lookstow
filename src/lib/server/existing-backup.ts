import { field } from './actions.ts';
import { backupEngine, database, dataDir } from './runtime.ts';
import { confirmsDeletion, deleteMailboxBackup } from './services/mailboxes/delete-backup.ts';
import { mailboxById } from './services/mailboxes/repository.ts';
import { effectiveBackupRoot } from './services/settings/settings.ts';

/**
 * What the console does with a mailbox's existing backup when it stops being backed up
 * (Exclude, Unpick, Delete backup): stop its sync after the current page, then, only when the
 * form chose `existing=delete` and the address was typed, delete the backup. Returns a refusal
 * in plain words, or null when done.
 */
export async function resolveExistingBackup(id: string, data: FormData): Promise<string | null> {
	if (field(data, 'existing') === 'delete') {
		const lockdown = backupEngine().lockdown();
		if (lockdown !== null) return lockdown;
	}
	const mailbox = mailboxById(database, id);
	const engine = backupEngine();
	engine.cancel(id);
	if (mailbox === undefined || field(data, 'existing') !== 'delete') {
		return null;
	}
	if (!confirmsDeletion(field(data, 'confirm'), mailbox.address)) {
		return `Type ${mailbox.address} to confirm deleting its backup.`;
	}
	if (!(await engine.waitUntilIdle(id))) {
		return 'Its sync is still finishing a page. Try again in a minute.';
	}
	await deleteMailboxBackup(database, mailbox, effectiveBackupRoot(database, dataDir()), 'console');
	return null;
}
