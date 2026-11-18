import { existsSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DiskStatus } from '../../../domain/engine.ts';

/**
 * How full the backup folder's drive is. Lookstow pauses every sync before the drive fills:
 * a full drive would fail every mailbox at once, and can stop the computer itself from working.
 * The folder may not exist yet (nothing backed up), so the nearest existing parent is measured.
 */
export function measureDisk(path: string): { totalBytes: number; freeBytes: number } | null {
	let probe = resolve(path);
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) {
			return null;
		}
		probe = parent;
	}
	const stats = statfsSync(probe);
	const totalBytes = stats.blocks * stats.bsize;
	// bavail: what an unprivileged user may still write, which is what the service can use.
	const freeBytes = stats.bavail * stats.bsize;
	return totalBytes > 0 ? { totalBytes, freeBytes } : null;
}

export function diskStatus(
	path: string,
	measured: { totalBytes: number; freeBytes: number } | null,
	limits: { warnPercent: number; pausePercent: number }
): DiskStatus {
	if (measured === null) {
		return {
			path,
			totalBytes: null,
			freeBytes: null,
			usedPercent: null,
			level: 'unknown',
			...limits
		};
	}
	const usedPercent = ((measured.totalBytes - measured.freeBytes) / measured.totalBytes) * 100;
	const level =
		usedPercent >= limits.pausePercent ? 'full' : usedPercent >= limits.warnPercent ? 'warn' : 'ok';
	return { path, ...measured, usedPercent, level, ...limits };
}
