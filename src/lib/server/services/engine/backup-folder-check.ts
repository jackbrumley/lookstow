import type { Queryable } from '../../database/connection.ts';
import { errorText } from '../../log.ts';
import { recordActivity } from '../activity/activity.ts';
import { newestStoredPath } from '../mailboxes/repository.ts';
import { readBackupMarker, saveBackupMarker } from '../settings/settings.ts';
import { checkBackupFolder, writeMarker } from '../storage/backup-marker.ts';

/**
 * Why nothing may be written to the backup folder now, or null when it is the one the index
 * knows (docs/specs/SPEC-BACKUP-FOLDER-MOVE.md). A new folder, or one from before markers that
 * holds the stored mail, is marked here.
 */
export function backupFolderProblem(db: Queryable, root: string): string | null {
	const known = readBackupMarker(db);
	const check = checkBackupFolder(root, known, () => newestStoredPath(db));
	switch (check.kind) {
		case 'ok':
			return null;
		case 'refused':
			return check.reason;
		case 'mark':
			try {
				writeMarker(root, check.id);
			} catch (error) {
				return `Lookstow cannot write the backup folder's marker in ${root} (${errorText(error)}). Backups are stopped until it can.`;
			}
			if (known === null) {
				saveBackupMarker(db, { id: check.id });
				recordActivity(db, {
					level: 'info',
					kind: 'backup-move',
					actor: 'system',
					summary: `The backup folder ${root} was marked as this Lookstow's backup`,
					detail:
						'A small file, .lookstow-backup, lets Lookstow tell when the backup drive is not attached, so it never writes a new backup in the wrong place.'
				});
			}
			return null;
	}
}
