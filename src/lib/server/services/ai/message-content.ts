import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Queryable } from '../../database/connection.ts';
import type { MessageDetail } from '../../../domain/messages.ts';
import { archiveItemAsEml } from '../fts/fts-download.ts';
import { messageDetail } from '../messages/search.ts';
import { resolveStoragePath } from '../storage/eml-store.ts';
import { parseEml, type ParsedMessage } from './mime.ts';

/**
 * A stored message read for the AI tools: its index entry and its parsed content. Mail is read
 * from its .eml file; an online archive item is converted from its .fts file first (the same
 * conversion as its .eml download). Files are only read, never changed.
 */
export type LoadedMessage = { detail: MessageDetail; parsed: ParsedMessage };

export async function loadMessage(
	db: Queryable,
	backupRoot: string,
	id: string
): Promise<LoadedMessage | { error: string }> {
	const detail = messageDetail(db, id);
	if (detail === null) return { error: `No message with id ${id}` };
	let raw: Buffer;
	if (detail.filePath.endsWith('.fts')) {
		const converted = await archiveItemAsEml(db, backupRoot, id);
		if (converted.kind === 'refused') return { error: converted.reason };
		raw = converted.eml;
	} else {
		try {
			raw = await readFile(resolveStoragePath(backupRoot, detail.filePath));
		} catch {
			return { error: 'The stored file is missing from the backup folder' };
		}
	}
	return { detail, parsed: parseEml(raw) };
}

export function sha256Of(data: Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}
