import { open, stat } from 'node:fs/promises';
import { zipSafeName } from '../../../domain/evidence-packs.ts';
import { listPacks, packZipPath } from './packs.ts';

const CHUNK = 1024 * 1024;

/** Bytes `start` to `end` (inclusive) of a file, read a megabyte at a time as they are sent. */
function fileStream(path: string, start: number, end: number): ReadableStream<Uint8Array> {
	let position = start;
	const opened = open(path, 'r');
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const file = await opened;
			const length = Math.min(CHUNK, end + 1 - position);
			if (length <= 0) {
				await file.close();
				controller.close();
				return;
			}
			const buffer = new Uint8Array(length);
			const { bytesRead } = await file.read(buffer, 0, length, position);
			if (bytesRead === 0) {
				await file.close();
				controller.error(new Error('The pack file ended early'));
				return;
			}
			position += bytesRead;
			controller.enqueue(buffer.subarray(0, bytesRead));
		},
		async cancel() {
			await (await opened).close();
		}
	});
}

/**
 * A finished pack's ZIP, streamed from disk (docs/specs/SPEC-EVIDENCE-PACKS.md): never read
 * into memory, with its size given, and resumable (a byte range), so a download of several
 * gigabytes that drops part-way carries on. The ETag is the ZIP's SHA-256, so a resumed download
 * never mixes two packs.
 */
export type RangeAsked = { start: number; end: number } | 'whole' | 'unsatisfiable';

/** Reads a Range header for one range of a file of `size` bytes. */
export function rangeOf(header: string | null, size: number): RangeAsked {
	if (header === null) return 'whole';
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return 'whole';
	const [, first = '', last = ''] = match;
	if (first === '' && last === '') return 'whole';
	if (first === '') {
		const suffix = Number(last);
		if (suffix === 0) return 'unsatisfiable';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
	if (start >= size || end < start) return 'unsatisfiable';
	return { start, end };
}

export async function packDownload(
	dataDir: string,
	id: string,
	request: Request
): Promise<{ response: Response; name: string } | null> {
	const { packs } = await listPacks(dataDir);
	const pack = packs.find((each) => each.id === id);
	if (pack?.status !== 'ready' || pack.sha256 === null) return null;
	const path = packZipPath(dataDir, id);
	const size = (await stat(path)).size;
	const filename = `${zipSafeName(pack.name, 80)}.zip`;
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
	const etag = `"${pack.sha256}"`;
	const headers: Record<string, string> = {
		'content-type': 'application/zip',
		'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
		'accept-ranges': 'bytes',
		etag,
		'cache-control': 'no-store'
	};
	// A resume asks only while the pack is the same one (If-Range).
	const ifRange = request.headers.get('if-range');
	const asked =
		ifRange !== null && ifRange !== etag ? 'whole' : rangeOf(request.headers.get('range'), size);
	if (asked === 'unsatisfiable') {
		return {
			name: pack.name,
			response: new Response(null, {
				status: 416,
				headers: { ...headers, 'content-range': `bytes */${String(size)}` }
			})
		};
	}
	const range = asked === 'whole' ? { start: 0, end: size - 1 } : asked;
	const stream = fileStream(path, range.start, range.end);
	return {
		name: pack.name,
		response: new Response(stream, {
			status: asked === 'whole' ? 200 : 206,
			headers: {
				...headers,
				'content-length': String(range.end - range.start + 1),
				...(asked === 'whole'
					? {}
					: {
							'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`
						})
			}
		})
	};
}
