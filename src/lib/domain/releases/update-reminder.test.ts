import { describe, expect, it } from 'vitest';
import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';
import { highlightsOf, REMIND_AGAIN_MS, updateOffer } from './update-reminder.ts';

const NOW = Date.parse('2026-11-23T00:00:00.000Z');

function view(
	release: string | null,
	phase: ServerUpdateView['operation']['phase'] = 'idle'
): ServerUpdateView {
	return {
		installedVersion: '0.13.2',
		deployment: 'installed',
		checkedAtIso: '2026-11-23T00:00:00.000Z',
		lastSuccessAtIso: '2026-11-23T00:00:00.000Z',
		release:
			release === null
				? null
				: {
						version: release,
						notes: '## Changes\n\n- **Faster** archive pages\n- Update reminders\n',
						publishedAtIso: '2026-11-23T00:00:00.000Z',
						manifest: {
							schemaVersion: 1,
							version: release,
							target: 'x86_64-pc-windows-msvc',
							archive: 'lookstow-windows-x64.zip',
							bytes: 1,
							sha256: 'a'.repeat(64),
							minimumLauncher: '0.1.0',
							nodeMajor: 26,
							rollbackFrom: []
						}
					},
		problem: null,
		install: { allowed: true, reason: '' },
		operation: { phase, from: null, to: null, message: '', atIso: null },
		lastUpdateSteps: []
	};
}

const NONE = { snoozedUntil: null, skippedVersion: null };

describe('the update reminder', () => {
	it('reminds on every page but Updates when a newer release is offered', () => {
		expect(updateOffer(view('0.13.3'), 'other', NONE, false, NOW)?.remind).toBe(true);
		expect(updateOffer(view('0.13.3'), 'updates', NONE, false, NOW)?.remind).toBe(false);
		expect(updateOffer(view(null), 'other', NONE, false, NOW)).toBeNull();
		expect(updateOffer(view('0.13.3', 'downloading'), 'other', NONE, false, NOW)).toBeNull();
	});

	it('waits a day after "later", forever for a skipped version, and while the backup moves', () => {
		const later = {
			snoozedUntil: new Date(NOW + REMIND_AGAIN_MS).toISOString(),
			skippedVersion: null
		};
		expect(updateOffer(view('0.13.3'), 'other', later, false, NOW)?.remind).toBe(false);
		expect(
			updateOffer(view('0.13.3'), 'other', later, false, NOW + REMIND_AGAIN_MS + 1)?.remind
		).toBe(true);
		const skipped = { snoozedUntil: null, skippedVersion: '0.13.3' };
		expect(updateOffer(view('0.13.3'), 'other', skipped, false, NOW)?.remind).toBe(false);
		expect(updateOffer(view('0.13.4'), 'other', skipped, false, NOW)?.remind).toBe(true);
		expect(updateOffer(view('0.13.3'), 'other', NONE, true, NOW)?.remind).toBe(false);
	});

	it('shows the first lines of the notes without Markdown marks', () => {
		expect(highlightsOf('## Changes\n\n- **Faster** archive pages\n- `x` done\n')).toEqual([
			'Changes',
			'Faster archive pages',
			'x done'
		]);
	});
});
