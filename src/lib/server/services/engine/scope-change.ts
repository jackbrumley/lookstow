import type { Queryable } from '../../database/connection.ts';
import type { ScopeSettings } from '../../../domain/settings.ts';
import { formatBytes, plural } from '../../../utils/format.ts';
import { deleteMailboxBackup } from '../mailboxes/delete-backup.ts';
import { allMailboxes, type MailboxRow } from '../mailboxes/repository.ts';
import { readScope, saveScope, SettingsError } from '../settings/settings.ts';
import type { Engine } from './engine.ts';
import { inScope } from './scope.ts';

/** What the engine does for a scope change: stop syncs, wait for them, start new ones. */
export type ScopeEngine = Pick<Engine, 'cancel' | 'waitUntilIdle' | 'requestSync'>;

/** What happens to the backups of mailboxes that are not backed up after the change. */
export type ExistingBackups = { kind: 'keep' } | { kind: 'delete'; confirmation: string };

/** A number of mailboxes with backups, and their size. */
export type BackupTotal = { mailboxes: number; bytes: number };

export type ScopeChange =
	| { kind: 'refused'; reason: string }
	| {
			kind: 'saved';
			joining: number;
			leaving: number;
			existing: ExistingBackups['kind'];
			/** Backups deleted by this change. */
			deleted: BackupTotal;
			/** Backups of mailboxes not backed up that stay on the drive. */
			kept: BackupTotal;
			/** Mailboxes whose backup was not deleted because their sync did not stop in time. */
			stillSyncing: string[];
	  };

/** The word typed to confirm deleting backups. */
export const DELETE_CONFIRMATION = 'DELETE';

function total(rows: readonly MailboxRow[]): BackupTotal {
	return { mailboxes: rows.length, bytes: rows.reduce((sum, row) => sum + row.byteCount, 0) };
}

/** Mailboxes the scope leaves out that still have stored messages. */
function backupsOutside(rows: readonly MailboxRow[], scope: ScopeSettings): MailboxRow[] {
	return rows.filter((row) => row.itemCount > 0 && !inScope(row, scope));
}

/** The backups of mailboxes the saved scope does not back up, for the Settings page. */
export function backupsOutsideScope(db: Queryable): BackupTotal {
	return total(backupsOutside(allMailboxes(db), readScope(db)));
}

/**
 * Saves a new scope. Syncs of mailboxes it leaves out stop after their current page, and
 * mailboxes it adds sync next. With `delete`, the backup of every mailbox that is not backed up
 * after the change is deleted: those this change leaves out and those left out earlier, so the
 * backup drive holds only what is backed up. The stored messages decide which mailboxes have a
 * backup.
 */
export async function changeScope(
	db: Queryable,
	engine: ScopeEngine,
	backupRoot: string,
	scope: ScopeSettings,
	existing: ExistingBackups
): Promise<ScopeChange> {
	if (existing.kind === 'delete' && existing.confirmation.trim() !== DELETE_CONFIRMATION) {
		return {
			kind: 'refused',
			reason: `Type ${DELETE_CONFIRMATION} to confirm deleting the backups. Nothing was changed.`
		};
	}
	const previous = readScope(db);
	const before = new Set(
		allMailboxes(db)
			.filter((row) => inScope(row, previous))
			.map((row) => row.id)
	);
	try {
		saveScope(db, scope);
	} catch (error) {
		if (error instanceof SettingsError) {
			return { kind: 'refused', reason: error.message };
		}
		throw error;
	}
	const saved = readScope(db);
	const rows = allMailboxes(db);
	const leaving = rows.filter((row) => before.has(row.id) && !inScope(row, saved));
	const joining = rows.filter((row) => !before.has(row.id) && inScope(row, saved));
	for (const row of leaving) {
		engine.cancel(row.id);
	}

	const outside = backupsOutside(rows, saved);
	const deleted: MailboxRow[] = [];
	const stillSyncing: MailboxRow[] = [];
	if (existing.kind === 'delete') {
		for (const row of outside) {
			engine.cancel(row.id);
			if (await engine.waitUntilIdle(row.id)) {
				await deleteMailboxBackup(db, row, backupRoot, 'console');
				deleted.push(row);
			} else {
				stillSyncing.push(row);
			}
		}
	}
	engine.requestSync(joining.map((row) => row.id));
	return {
		kind: 'saved',
		joining: joining.length,
		leaving: leaving.length,
		existing: existing.kind,
		deleted: total(deleted),
		kept: total(existing.kind === 'delete' ? stillSyncing : outside),
		stillSyncing: stillSyncing.map((row) => row.address)
	};
}

/** The outcome in plain words, for the toast and the activity log. */
export function describeScopeChange(change: Extract<ScopeChange, { kind: 'saved' }>): string {
	const parts = [
		`${plural(change.joining, 'mailbox', 'mailboxes')} start being backed up`,
		`${plural(change.leaving, 'mailbox', 'mailboxes')} stop`
	];
	const sized = (backups: BackupTotal) =>
		`${plural(backups.mailboxes, 'mailbox', 'mailboxes')} (${formatBytes(backups.bytes)})`;
	if (change.existing === 'delete') {
		parts.push(
			change.deleted.mailboxes > 0
				? `deleted the backups of ${sized(change.deleted)} that are not backed up`
				: change.stillSyncing.length === 0
					? 'no mailbox that is not backed up has a backup, so nothing was deleted'
					: 'nothing was deleted yet'
		);
		if (change.stillSyncing.length > 0) {
			parts.push(
				`kept ${change.stillSyncing.join(', ')}: still finishing a sync; save again in a minute to delete`
			);
		}
	} else if (change.kept.mailboxes > 0) {
		parts.push(`${sized(change.kept)} that are not backed up keep their backups`);
	}
	return parts.join(', ');
}
