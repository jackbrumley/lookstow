import { error } from '@sveltejs/kit';
import { aiTools, database } from '../../runtime.ts';
import { messageDetail } from '../messages/search.ts';
import { bodyPolicy, inlineType, previewKind } from './view-message.ts';

/**
 * The viewer's replies (docs/specs/SPEC-VIEWER.md), shared by a message's routes and those of a
 * forwarded email inside it (`part`: that email's attachment index).
 */

/** A route's number (an attachment's or a forwarded email's index); anything else is a 404. */
function wholeNumber(text: string): number {
	if (!/^\d{1,6}$/.test(text)) error(404, 'No such part of this message');
	return Number.parseInt(text, 10);
}

function partOf(text: string | null): number | null {
	return text === null ? null : wholeNumber(text);
}

/** A message's page data: its index entry and the message read for showing. */
export async function messagePageData(id: string, partText: string | null) {
	const part = partOf(partText);
	const message = messageDetail(database, id);
	if (message === null) error(404, 'No such message');
	const reply = await aiTools().view(id, part);
	return {
		message,
		part,
		view: 'view' in reply ? reply.view : null,
		viewProblem: 'error' in reply ? reply.error : null
	};
}

/**
 * The body for the viewer's frame, locked down by its own headers too: no scripts, no forms,
 * nothing loaded but its own pictures (and the internet's with ?remote=1), framed only by
 * Lookstow's own pages.
 */
export async function bodyResponse(
	id: string,
	partText: string | null,
	url: URL
): Promise<Response> {
	const reply = await aiTools().body(id, partOf(partText));
	if ('error' in reply) error(404, reply.error);
	const remote = url.searchParams.get('remote') === '1';
	return new Response(reply.document, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy': `${bodyPolicy(remote)}; frame-ancestors 'self'`,
			'x-frame-options': 'SAMEORIGIN',
			'cache-control': 'no-store'
		}
	});
}

/**
 * One attachment. `inline`: pictures, PDFs and plain text open in the browser; everything else,
 * and anything that could run (HTML, scripts, SVG), always downloads.
 */
export async function attachmentResponse(
	id: string,
	partText: string | null,
	indexText: string,
	inline: boolean
): Promise<Response> {
	const found = await aiTools().part(id, partOf(partText), wholeNumber(indexText), inline);
	if ('error' in found) error(404, found.error);
	const kind = previewKind(found.contentType, found.filename, found.data.length);
	const shown = inline && kind !== null && kind !== 'email';
	const ascii = found.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
	const name = `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(found.filename)}`;
	return new Response(new Uint8Array(found.data), {
		headers: {
			'content-type': shown ? inlineType(kind, found.contentType) : 'application/octet-stream',
			'content-length': String(found.data.length),
			'content-disposition': `${shown ? 'inline' : 'attachment'}; ${name}`,
			'x-content-type-options': 'nosniff',
			'cache-control': 'no-store',
			// A PDF shows in the lightbox's frame (ui/lightbox.svelte): framed by Lookstow's own
			// pages only. Anything that downloads stays unframed (hooks.server.ts sets DENY).
			...(shown
				? { 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'" }
				: {})
		}
	});
}
