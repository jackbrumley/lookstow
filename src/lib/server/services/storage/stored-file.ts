import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

const CHUNK_BYTES = 64 * 1024;

/** A stored backup file opened for reading: its size and its bytes as a web stream. */
export type OpenedStoredFile = { byteCount: number; body: ReadableStream<Uint8Array> };

/**
 * Opens a stored backup file to send it, or returns null when it is not on disk.
 * The stream closes the file when it ends or the reader cancels it.
 */
export async function openStoredFile(path: string): Promise<OpenedStoredFile | null> {
	let handle: FileHandle;
	try {
		handle = await open(path, 'r');
	} catch {
		return null;
	}
	const { size } = await handle.stat();
	return { byteCount: size, body: readChunks(handle) };
}

function readChunks(handle: FileHandle): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const buffer = new Uint8Array(CHUNK_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
			if (bytesRead === 0) {
				await handle.close();
				controller.close();
				return;
			}
			controller.enqueue(buffer.subarray(0, bytesRead));
		},
		async cancel() {
			await handle.close();
		}
	});
}
