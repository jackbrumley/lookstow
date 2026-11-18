import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { database } from '#lib/server/runtime.ts';
import { readConnection } from '#lib/server/services/settings/settings.ts';

/**
 * The public certificate, as a .cer file to upload to the app registration in Microsoft Entra
 * (Certificates & secrets > Certificates > Upload). Never the private key.
 */
export const GET: RequestHandler = () => {
	const { auth } = readConnection(database);
	if (auth.kind !== 'certificate') {
		error(404, 'Create a certificate on the Settings page first');
	}
	return new Response(auth.certificatePem, {
		headers: {
			'content-type': 'application/x-x509-ca-cert',
			'content-disposition': 'attachment; filename="lookstow.cer"',
			'cache-control': 'no-store'
		}
	});
};
