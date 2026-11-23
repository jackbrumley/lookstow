import type { RequestHandler } from './$types';
import { database } from '#lib/server/runtime.ts';
import { readRemote } from '#lib/server/services/settings/settings.ts';

/**
 * GET /lookstow-certificate.pem: the remote address's self-signed certificate (public, like any
 * site's), so another computer's AI tools can be told to trust it (docs/specs/SPEC-REMOTE.md).
 */
export const GET: RequestHandler = () => {
	const pem = readRemote(database).certificatePem;
	if (pem === null) return new Response('Remote access has no certificate yet.', { status: 404 });
	return new Response(pem, {
		headers: {
			'content-type': 'application/x-pem-file',
			'content-disposition': 'attachment; filename="lookstow.pem"',
			'cache-control': 'no-store'
		}
	});
};
