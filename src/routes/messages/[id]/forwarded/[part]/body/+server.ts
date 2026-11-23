import type { RequestHandler } from './$types';
import { bodyResponse } from '#lib/server/services/viewer/responses.ts';

/** GET /messages/{id}/forwarded/{part}/body: a forwarded email's body for the viewer's frame. */
export const GET: RequestHandler = ({ params, url }) => bodyResponse(params.id, params.part, url);
