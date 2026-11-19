import { readFile } from 'node:fs/promises';
import type { Queryable } from '../../database/connection.ts';
import { serverLog } from '../../log.ts';
import { archiveItemsToIndex, setMessageIndex } from '../mailboxes/repository.ts';
import { resolveStoragePath } from '../storage/eml-store.ts';
import { summarise, type FtsSummary } from './fts-properties.ts';
import { readFts } from './fts-reader.ts';

/**
 * Online archive items in the index: what Search needs (subject, sender, recipients, received
 * date, Message-ID), read from the stored `.fts` file. New items are read as they are copied;
 * items copied before Lookstow could read them are read once, in the background, at start-up.
 */

/** The item's index fields, or null (and a log line naming the item) if it cannot be read. */
export function indexFts(data: Buffer, where: string): FtsSummary | null {
	try {
		return summarise(readFts(data));
	} catch (error) {
		serverLog(
			'warn',
			'archive',
			`Could not read an archive item in ${where} for Search (${error instanceof Error ? error.message : String(error)}); it is stored as it came`
		);
		return null;
	}
}

export type IndexOutcome = { total: number; indexed: number; problems: number; stopped: boolean };

/**
 * Archive items copied before 0.6.0 have no subject, sender or Message-ID in the index; this
 * reads each one's file and fills them in. The files are only read, never changed or moved.
 */
export async function indexArchiveItems(
	db: Queryable,
	backupRoot: string,
	stopping: () => boolean
): Promise<IndexOutcome> {
	const rows = archiveItemsToIndex(db);
	const outcome: IndexOutcome = { total: rows.length, indexed: 0, problems: 0, stopped: false };
	for (const row of rows) {
		if (stopping()) {
			outcome.stopped = true;
			break;
		}
		let summary: FtsSummary | null;
		try {
			const data = await readFile(resolveStoragePath(backupRoot, row.filePath));
			summary = indexFts(data, row.filePath);
		} catch (error) {
			serverLog(
				'warn',
				'archive',
				`Could not open ${row.filePath} to index it (${error instanceof Error ? error.message : String(error)})`
			);
			summary = null;
		}
		if (summary === null) {
			outcome.problems += 1;
			continue;
		}
		setMessageIndex(db, row.id, {
			subject: summary.subject,
			sender: summary.sender,
			recipients: summary.recipients.join(' '),
			internetMessageId: summary.internetMessageId,
			receivedAt: summary.receivedAt === null ? row.receivedAt : new Date(summary.receivedAt)
		});
		outcome.indexed += 1;
	}
	return outcome;
}
