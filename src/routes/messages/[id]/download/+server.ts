import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { database, dataDir } from '#lib/server/runtime.ts';
import { messageDetail } from '#lib/server/services/messages/search.ts';
import { resolveStoragePath } from '#lib/server/services/storage/eml-store.ts';
import { effectiveBackupRoot } from '#lib/server/services/settings/settings.ts';

/** The stored file of one message, as a download: .eml opens in any mail program. */
export const GET = (async ({ params }) => {
	const message = messageDetail(database, params.id);
	if (message === null) {
		error(404, 'No such message');
	}
	const path = resolveStoragePath(effectiveBackupRoot(database, dataDir()), message.filePath);
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch {
		error(404, 'The stored file is missing from the backup folder');
	}
	const name = message.filePath.split('/').at(-1) ?? 'message.eml';
	// A plain-ASCII name for old browsers, and the exact name (filename*) for the rest.
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
		headers: {
			'content-type': name.endsWith('.eml') ? 'message/rfc822' : 'application/octet-stream',
			'content-length': String(size),
			'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			'cache-control': 'no-store'
		}
	});
}) satisfies RequestHandler;
