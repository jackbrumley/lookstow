import { rm } from 'node:fs/promises';
import type { Queryable } from '../../database/connection.ts';
import { recordActivity } from '../activity/activity.ts';
import { mailboxFolderName, resolveStoragePath } from '../storage/eml-store.ts';
import { clearMailboxBackup, type MailboxRow } from './repository.ts';

/**
 * Deletes a mailbox's backup: its folder under the backup root and everything the index knows
 * about it. Only ever on an explicit choice in the console, with the address typed to confirm;
 * the caller stops the mailbox's sync first. The mailbox itself stays listed (it is still in
 * Microsoft 365), ready to be backed up again from scratch.
 */
export type BackupOwner = Pick<MailboxRow, 'id' | 'address' | 'kind' | 'itemCount' | 'byteCount'>;

export async function deleteMailboxBackup(
	db: Queryable,
	mailbox: BackupOwner,
	backupRoot: string,
	actor: string
): Promise<void> {
	const folder = resolveStoragePath(backupRoot, mailboxFolderName(mailbox.address, mailbox.kind));
	await rm(folder, { recursive: true, force: true });
	clearMailboxBackup(db, mailbox.id);
	recordActivity(db, {
		level: 'warn',
		kind: 'backup-deleted',
		actor,
		summary: `The backup of ${mailbox.address} (${mailbox.kind}) was deleted`,
		detail: `${mailbox.itemCount} messages in ${folder}`,
		mailboxId: mailbox.id
	});
}

/** Whether the typed confirmation matches: the mailbox's address, any case, spaces trimmed. */
export function confirmsDeletion(typed: string, address: string): boolean {
	return typed.trim().toLowerCase() === address.toLowerCase();
}
