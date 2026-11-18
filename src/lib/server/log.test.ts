import { describe, expect, it, vi } from 'vitest';
import { logSince, serverLog } from './log.ts';

describe('the in-memory log', () => {
	it('returns the lines after a sequence number, oldest first', () => {
		vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const before = logSince(0).at(-1)?.seq ?? 0;
		serverLog('info', 'test', 'one');
		serverLog('warn', 'test', 'two');
		const lines = logSince(before);
		expect(lines.map((line) => [line.level, line.message])).toEqual([
			['info', 'one'],
			['warn', 'two']
		]);
		expect(logSince(before + 1).map((line) => line.message)).toEqual(['two']);
		expect(logSince(before, 1).map((line) => line.message)).toEqual(['two']);
	});
});
