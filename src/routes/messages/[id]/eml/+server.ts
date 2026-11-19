import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { database, dataDir } from '#lib/server/runtime.ts';
import { archiveItemAsEml } from '#lib/server/services/fts/fts-download.ts';
import { effectiveBackupRoot } from '#lib/server/services/settings/settings.ts';

/** An online archive item as an `.eml` any mail program opens, made from its `.fts` file. */
export const GET = (async ({ params }) => {
	const download = await archiveItemAsEml(
		database,
		effectiveBackupRoot(database, dataDir()),
		params.id
	);
	if (download.kind === 'refused') {
		error(download.status, download.reason);
	}
	const ascii = download.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return new Response(new Uint8Array(download.eml), {
		headers: {
			'content-type': 'message/rfc822',
			'content-length': String(download.eml.length),
			'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(download.name)}`,
			'cache-control': 'no-store'
		}
	});
}) satisfies RequestHandler;
