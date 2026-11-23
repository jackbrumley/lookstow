import type { RequestHandler } from './$types';
import { attachmentResponse } from '#lib/server/services/viewer/responses.ts';

/** GET /messages/{id}/attachments/{index}: one attachment, as a download. */
export const GET: RequestHandler = ({ params }) =>
	attachmentResponse(params.id, null, params.index, false);
