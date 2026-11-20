import { describe, expect, it } from 'vitest';
import { indexingText, progressLine } from './indexing.ts';

describe('the search index banner', () => {
	it('says how far each step has got, and nothing when none runs', () => {
		expect(indexingText(null)).toBeNull();
		expect(indexingText({ stage: 'search-index', done: 230_000, total: 545_592 })).toContain(
			'230,000 of 545,592 messages (42%)'
		);
		expect(indexingText({ stage: 'content-moving', done: 0, total: 0 })).toContain('(100.0%)');
		expect(indexingText({ stage: 'content-waiting' })).toContain('once the update has settled');
		expect(progressLine('Search index', 54_559, 545_592)).toBe(
			'Search index: 54,559 of 545,592 messages (10%)'
		);
	});
});
