import type { RequestHandler } from './$types';
import { attachmentResponse } from '#lib/server/services/viewer/responses.ts';

/** GET .../forwarded/{part}/attachments/{index}/open: a forwarded email's attachment, shown. */
export const GET: RequestHandler = ({ params }) =>
	attachmentResponse(params.id, params.part, params.index, true);
