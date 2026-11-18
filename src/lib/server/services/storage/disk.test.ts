import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diskStatus, measureDisk } from './disk.ts';

const LIMITS = { warnPercent: 85, pausePercent: 90 };
const GB = 1024 ** 3;

describe('the disk guard', () => {
	it('measures the nearest existing folder when the backup folder does not exist yet', () => {
		const measured = measureDisk(join(tmpdir(), 'lookstow-not-there', 'mailboxes'));
		expect(measured?.totalBytes).toBeGreaterThan(0);
		expect(measured?.freeBytes).toBeLessThanOrEqual(measured?.totalBytes ?? 0);
	});

	it('warns from 85% used and pauses from 90%', () => {
		expect(diskStatus('/b', { totalBytes: 100 * GB, freeBytes: 20 * GB }, LIMITS).level).toBe('ok');
		expect(diskStatus('/b', { totalBytes: 100 * GB, freeBytes: 15 * GB }, LIMITS).level).toBe(
			'warn'
		);
		expect(diskStatus('/b', { totalBytes: 100 * GB, freeBytes: 10 * GB }, LIMITS)).toMatchObject({
			level: 'full',
			usedPercent: 90
		});
	});

	it('says unknown when nothing can be measured', () => {
		expect(diskStatus('/b', null, LIMITS)).toMatchObject({ level: 'unknown', usedPercent: null });
	});
});
