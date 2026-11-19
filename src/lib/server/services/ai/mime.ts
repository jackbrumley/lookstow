/**
 * Reads a stored message (.eml, RFC 5322 with MIME) far enough for the AI tools: its headers,
 * its text, and each attachment's name, type and bytes. Multipart parts are walked to any depth;
 * base64 and quoted-printable are decoded; RFC 2047 encoded words and RFC 2231 file names are
 * read. HTML-only messages give their text with the tags taken out. Nothing is written.
 */
type MimeAttachment = {
	index: number;
	filename: string;
	contentType: string;
	data: Buffer;
	/** Shown inside the message (a signature logo, a pasted picture) rather than attached. */
	inline: boolean;
};

export type ParsedMessage = {
	headers: Map<string, string>;
	text: string;
	attachments: MimeAttachment[];
};

type Part = { headers: Map<string, string>; body: Buffer };

const CRLF2 = Buffer.from('\r\n\r\n');
const LF2 = Buffer.from('\n\n');

function splitPart(raw: Buffer): Part {
	let end = raw.indexOf(CRLF2);
	let gap = 4;
	const lfEnd = raw.indexOf(LF2);
	if (end === -1 || (lfEnd !== -1 && lfEnd < end)) {
		end = lfEnd;
		gap = 2;
	}
	if (end === -1) return { headers: parseHeaders(raw.toString('latin1')), body: Buffer.alloc(0) };
	return {
		headers: parseHeaders(raw.subarray(0, end).toString('latin1')),
		body: raw.subarray(end + gap)
	};
}

function parseHeaders(text: string): Map<string, string> {
	const headers = new Map<string, string>();
	const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
	for (const line of unfolded.split(/\r?\n/)) {
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
	}
	return headers;
}

/** A header's parameter (`boundary`, `charset`, `name`, `filename`), RFC 2231 forms included. */
function parameter(header: string, name: string): string | null {
	const extended = new RegExp(`;\\s*${name}\\*0?\\*?=([^;]*)`, 'gi');
	const pieces = [...header.matchAll(extended)].map((match) => match[1]?.trim() ?? '');
	if (pieces.length > 0) {
		const joined = pieces.map((piece) => piece.replace(/^"|"$/g, '')).join('');
		const encoded = /^([^']*)'[^']*'(.*)$/.exec(joined);
		if (encoded !== null) {
			try {
				return decodeURIComponent(encoded[2] ?? '');
			} catch {
				return encoded[2] ?? '';
			}
		}
		return joined;
	}
	const plain = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(header);
	if (plain === null) return null;
	return decodeWords(plain[2] ?? plain[1] ?? '');
}

function charsetDecode(bytes: Buffer, charset: string): string {
	try {
		return new TextDecoder(charset.toLowerCase() === 'utf8' ? 'utf-8' : charset).decode(bytes);
	} catch {
		return bytes.toString('latin1');
	}
}

/** RFC 2047 encoded words: =?charset?B|Q?text?= */
function decodeWords(text: string): string {
	return text
		.replace(/\?=\s+=\?/g, '?==?')
		.replace(
			/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
			(_, charset: string, kind: string, data: string) => {
				const bytes =
					kind.toUpperCase() === 'B'
						? Buffer.from(data, 'base64')
						: quotedPrintable(data.replace(/_/g, ' '));
				return charsetDecode(bytes, charset);
			}
		);
}

function quotedPrintable(text: string): Buffer {
	const cleaned = text.replace(/=\r?\n/g, '');
	const bytes: number[] = [];
	for (let index = 0; index < cleaned.length; index++) {
		const character = cleaned.charCodeAt(index);
		if (character === 61 && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(index + 1, index + 3))) {
			bytes.push(Number.parseInt(cleaned.slice(index + 1, index + 3), 16));
			index += 2;
		} else {
			bytes.push(character & 0xff);
		}
	}
	return Buffer.from(bytes);
}

function decodeBody(part: Part): Buffer {
	const encoding = (part.headers.get('content-transfer-encoding') ?? '').toLowerCase();
	if (encoding === 'base64') return Buffer.from(part.body.toString('latin1'), 'base64');
	if (encoding === 'quoted-printable') return quotedPrintable(part.body.toString('latin1'));
	return part.body;
}

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
		.replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
	const marker = Buffer.from(`--${boundary}`);
	const parts: Buffer[] = [];
	let at = body.indexOf(marker);
	while (at !== -1) {
		let start = at + marker.length;
		if (body.subarray(start, start + 2).toString() === '--') break;
		const lineEnd = body.indexOf('\n', start);
		if (lineEnd === -1) break;
		start = lineEnd + 1;
		const next = body.indexOf(marker, start);
		let end = next === -1 ? body.length : next;
		// The line break before the next boundary belongs to the boundary.
		if (body[end - 1] === 0x0a) end -= 1;
		if (body[end - 1] === 0x0d) end -= 1;
		parts.push(body.subarray(start, end));
		at = next;
	}
	return parts;
}

export function parseEml(raw: Buffer): ParsedMessage {
	const root = splitPart(raw);
	const texts: { plain: string[]; html: string[] } = { plain: [], html: [] };
	const attachments: MimeAttachment[] = [];
	const walk = (part: Part, depth: number): void => {
		const type = part.headers.get('content-type') ?? 'text/plain';
		const mediaType = (type.split(';')[0] ?? 'text/plain').trim().toLowerCase();
		const disposition = part.headers.get('content-disposition') ?? '';
		const filename = parameter(disposition, 'filename') ?? parameter(type, 'name') ?? null;
		if (mediaType.startsWith('multipart/') && depth < 20) {
			const boundary = parameter(type, 'boundary');
			if (boundary !== null) {
				for (const child of splitMultipart(part.body, boundary)) walk(splitPart(child), depth + 1);
			}
			return;
		}
		const isAttachment =
			filename !== null ||
			/^attachment/i.test(disposition) ||
			!(mediaType.startsWith('text/') || mediaType === 'message/delivery-status');
		if (isAttachment) {
			attachments.push({
				index: attachments.length,
				filename: filename ?? `attachment-${String(attachments.length + 1)}`,
				contentType: mediaType,
				data: decodeBody(part),
				inline: /^inline/i.test(disposition) || part.headers.has('content-id')
			});
			return;
		}
		const text = charsetDecode(decodeBody(part), parameter(type, 'charset') ?? 'utf-8');
		if (mediaType === 'text/html') texts.html.push(text);
		else texts.plain.push(text);
	};
	walk(root, 0);
	const text =
		texts.plain.length > 0
			? texts.plain.join('\n\n').trim()
			: texts.html.map(htmlToText).join('\n\n');
	const headers = new Map([...root.headers].map(([name, value]) => [name, decodeWords(value)]));
	return { headers, text, attachments };
}
