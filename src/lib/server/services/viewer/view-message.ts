import type { ParsedMessage } from '../ai/mime.ts';
import type { MessageView, PreviewKind } from '../../../domain/viewer.ts';

/**
 * A stored message as the console shows it (docs/specs/SPEC-VIEWER.md): its headers, its body
 * as a document for a locked-down frame, and its attachments with how each can be previewed.
 * Nothing in a message runs: the body's frame allows no scripts or forms, its own pictures are
 * written into it, and pictures from the internet load only when asked for.
 */

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);
/** Pictures written into the body together, at most (a body never grows past this). */
const EMBEDDED_PICTURES_BYTES = 15 * 1024 * 1024;
/** Text attachments shown inline, at most. */
const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

function lower(name: string): string {
	return name.toLowerCase();
}

/** HEIC photos converted for viewing, at most (a 48-megapixel iPhone photo is about 15 MB). */
const HEIC_PREVIEW_BYTES = 40 * 1024 * 1024;

/** An iPhone photo (HEIC or HEIF), which browsers cannot show: viewed as a JPEG copy. */
export function isHeic(contentType: string, filename: string): boolean {
	const type = lower(contentType);
	const name = lower(filename);
	return (
		type === 'image/heic' ||
		type === 'image/heif' ||
		type === 'image/heic-sequence' ||
		type === 'image/heif-sequence' ||
		name.endsWith('.heic') ||
		name.endsWith('.heif')
	);
}

/** How an attachment can be shown on the page, or null (download only). */
export function previewKind(
	contentType: string,
	filename: string,
	bytes: number
): PreviewKind | null {
	const type = lower(contentType);
	const name = lower(filename);
	if (IMAGE_TYPES.has(type)) return 'image';
	// Converted to JPEG when viewed (viewer/heic.ts); the download is the original file.
	if (isHeic(type, name)) return bytes <= HEIC_PREVIEW_BYTES ? 'image' : null;
	if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
	if (type === 'message/rfc822' || name.endsWith('.eml')) return 'email';
	if ((type === 'text/plain' || type === 'text/csv') && bytes <= TEXT_PREVIEW_BYTES) return 'text';
	return null;
}

/** The content type an attachment is sent with when shown on the page (never anything that runs). */
export function inlineType(kind: PreviewKind, contentType: string): string {
	switch (kind) {
		case 'image':
			return lower(contentType);
		case 'pdf':
			return 'application/pdf';
		case 'text':
			return 'text/plain; charset=utf-8';
		case 'email':
			return 'message/rfc822';
	}
}

/** The Date header as an exact time (ISO 8601, UTC), shown in local time; null if unreadable. */
function sentAt(date: string): string | null {
	const when = Date.parse(date);
	return Number.isNaN(when) ? null : new Date(when).toISOString();
}

export function viewOf(parsed: ParsedMessage): MessageView {
	const header = (name: string): string => parsed.headers.get(name) ?? '';
	return {
		subject: header('subject'),
		from: header('from'),
		to: header('to'),
		cc: header('cc'),
		date: header('date'),
		sentAt: sentAt(header('date')),
		hasHtml: parsed.html !== null,
		attachments: parsed.attachments.map((attachment) => ({
			index: attachment.index,
			filename: attachment.filename,
			contentType: attachment.contentType,
			bytes: attachment.data.length,
			inline: attachment.inline,
			insideAttachment: attachment.insideAttachment,
			preview: previewKind(attachment.contentType, attachment.filename, attachment.data.length)
		}))
	};
}

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/**
 * The body as a whole document for its frame: the HTML body with its own pictures (`cid:`)
 * written in as data, or the text body in a <pre>. Links open in a new tab; nothing is sent as
 * the page a link came from.
 */
export function bodyDocument(parsed: ParsedMessage): string {
	const head = [
		'<!doctype html><html><head><meta charset="utf-8">',
		'<meta name="referrer" content="no-referrer">',
		'<base target="_blank">',
		'<style>body{font-family:system-ui,sans-serif;margin:12px;overflow-wrap:anywhere}',
		'img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit}</style></head><body>'
	].join('');
	if (parsed.html === null) {
		return `${head}<pre>${escapeHtml(parsed.plain ?? parsed.text)}</pre></body></html>`;
	}
	let budget = EMBEDDED_PICTURES_BYTES;
	const byId = new Map(
		parsed.attachments
			.filter((attachment) => attachment.contentId !== null && attachment.insideAttachment === null)
			.map((attachment) => [lower(attachment.contentId ?? ''), attachment])
	);
	const html = parsed.html.replace(/cid:([^"'\s)>]+)/gi, (whole, id: string) => {
		const attachment = byId.get(lower(id));
		if (attachment === undefined || !IMAGE_TYPES.has(lower(attachment.contentType))) return whole;
		if (attachment.data.length > budget) return whole;
		budget -= attachment.data.length;
		return `data:${lower(attachment.contentType)};base64,${attachment.data.toString('base64')}`;
	});
	return `${head}${html}</body></html>`;
}

/**
 * What the body's frame may load: its own pictures (written in as data), and pictures from the
 * internet only when asked for. Sent as a header, so the body is locked down even opened alone.
 */
export function bodyPolicy(remotePictures: boolean): string {
	const pictures = remotePictures ? 'img-src data: https: http:' : 'img-src data:';
	return [
		'sandbox allow-popups allow-popups-to-escape-sandbox',
		"default-src 'none'",
		pictures,
		"style-src 'unsafe-inline'",
		'font-src data:'
	].join('; ');
}
