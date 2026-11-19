import { readFile } from 'node:fs/promises';
import type { Queryable } from '../../database/connection.ts';
import { messageDetail } from '../messages/search.ts';
import { resolveStoragePath } from '../storage/eml-store.ts';
import { toEml } from './fts-eml.ts';
import { readFts } from './fts-reader.ts';

/**
 * An online archive item as an `.eml` download, made from its stored `.fts` file when asked for.
 * The `.fts` file is only read; it stays the record.
 */
export type EmlDownload =
	| { kind: 'ready'; name: string; eml: Buffer }
	| { kind: 'refused'; status: 400 | 404 | 422; reason: string };

export async function archiveItemAsEml(
	db: Queryable,
	backupRoot: string,
	messageId: string
): Promise<EmlDownload> {
	const message = messageDetail(db, messageId);
	if (message === null) {
		return { kind: 'refused', status: 404, reason: 'No such message' };
	}
	if (!message.filePath.endsWith('.fts')) {
		return {
			kind: 'refused',
			status: 400,
			reason: 'This message is stored as .eml already: download it as it is.'
		};
	}
	let data: Buffer;
	try {
		data = await readFile(resolveStoragePath(backupRoot, message.filePath));
	} catch {
		return {
			kind: 'refused',
			status: 404,
			reason: 'The stored file is missing from the backup folder'
		};
	}
	try {
		return {
			kind: 'ready',
			name: (message.filePath.split('/').at(-1) ?? 'message.fts').replace(/\.fts$/, '.eml'),
			eml: toEml(readFts(data))
		};
	} catch (problem) {
		return {
			kind: 'refused',
			status: 422,
			reason: `Lookstow could not read this archive item (${problem instanceof Error ? problem.message : String(problem)}). Download the original .fts file instead.`
		};
	}
}
