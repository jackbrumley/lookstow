import { describe, expect, it } from 'vitest';
import { EXPORT_BATCH } from '../graph/archive.ts';
import {
	ByteBudget,
	EXPORT_BATCH_BYTES,
	exportBatches,
	GIANT_ITEM_BYTES
} from './export-batches.ts';

describe('archive export batches', () => {
	it('keeps each batch to its item count and its size, and a big item on its own', () => {
		const small = Array.from({ length: EXPORT_BATCH + 5 }, (_, index) => ({
			id: `s${String(index)}`,
			size: 1000
		}));
		expect(exportBatches(small).map((batch) => batch.ids.length)).toEqual([EXPORT_BATCH, 5]);
		const huge = { id: 'huge', size: EXPORT_BATCH_BYTES * 2 };
		const mixed = exportBatches([{ id: 'a', size: 10 }, huge, { id: 'b', size: 10 }]);
		expect(mixed.map((batch) => batch.ids)).toEqual([['a'], ['huge'], ['b']]);
	});

	it('exports each giant item on its own, after the ordinary ones, marked to be tried once', () => {
		const batches = exportBatches([
			{ id: 'giant', size: GIANT_ITEM_BYTES },
			{ id: 'a', size: 10 },
			{ id: 'b', size: 10 }
		]);
		expect(batches.map((batch) => [batch.ids, batch.giant])).toEqual([
			[['a', 'b'], false],
			[['giant'], true]
		]);
	});

	it('holds takers while the budget is used, but always lets one through when it is empty', async () => {
		const budget = new ByteBudget(100);
		const first = await budget.take(80);
		let second: (() => void) | null = null;
		void budget.take(50).then((release) => {
			second = release;
		});
		await Promise.resolve();
		expect(second).toBeNull();
		first();
		await Promise.resolve();
		expect(second).not.toBeNull();
		// Bigger than the whole budget, but nothing else holds any: it goes.
		const lone = new ByteBudget(100);
		const release = await lone.take(500);
		expect(lone.used).toBe(500);
		release();
		expect(lone.used).toBe(0);
	});
});
