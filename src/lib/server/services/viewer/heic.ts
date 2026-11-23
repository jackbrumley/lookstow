import convert from 'heic-convert';
import { errorText, serverLog } from '../../log.ts';
import { isHeic } from './view-message.ts';

/**
 * iPhone photos (HEIC) for the viewer (docs/specs/SPEC-VIEWER.md): browsers cannot show them, so
 * viewing one sends a JPEG copy made on the reading thread with heic-convert (libheif compiled to
 * WebAssembly, no native code). Downloading always sends the original file; the copy is only for
 * looking at. The last few copies are kept, as a page shows a photo and then opens it.
 */
type Picture = { filename: string; contentType: string; data: Buffer };

const KEPT = 6;
const kept = new Map<string, Picture>();

function jpegName(filename: string): string {
	const base = filename.replace(/\.(heic|heif)$/i, '');
	return `${base === '' ? 'photo' : base}.jpg`;
}

/**
 * The attachment as the browser can show it: a HEIC photo as a JPEG copy, anything else as it
 * is. A photo that cannot be converted is sent as it is (and so downloads).
 */
export async function viewable(key: string, attachment: Picture): Promise<Picture> {
	if (!isHeic(attachment.contentType, attachment.filename)) return attachment;
	const known = kept.get(key);
	if (known !== undefined) return known;
	try {
		const jpeg = await convert({ buffer: attachment.data, format: 'JPEG', quality: 0.85 });
		const picture = {
			filename: jpegName(attachment.filename),
			contentType: 'image/jpeg',
			data: Buffer.from(jpeg)
		};
		kept.set(key, picture);
		while (kept.size > KEPT) {
			const oldest = kept.keys().next().value;
			if (oldest === undefined) break;
			kept.delete(oldest);
		}
		return picture;
	} catch (error) {
		serverLog(
			'warn',
			'viewer',
			`Could not convert the HEIC photo ${attachment.filename} for viewing: ${errorText(error)}`
		);
		return attachment;
	}
}
