import type { RequestHandler } from './$types';
import { attachmentResponse } from '#lib/server/services/viewer/responses.ts';

/** GET /messages/{id}/attachments/{index}/open: a picture, PDF or text in the browser. */
export const GET: RequestHandler = ({ params }) =>
	attachmentResponse(params.id, null, params.index, true);
