import type { RequestHandler } from './$types';
import { attachmentResponse } from '#lib/server/services/viewer/responses.ts';

/** GET /messages/{id}/forwarded/{part}/attachments/{index}: a forwarded email's attachment. */
export const GET: RequestHandler = ({ params }) =>
	attachmentResponse(params.id, params.part, params.index, false);
