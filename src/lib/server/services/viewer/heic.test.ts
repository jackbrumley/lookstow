import { describe, expect, it } from 'vitest';
import { viewable } from './heic.ts';

/**
 * A real HEIC photo cannot be invented here (nothing in the toolchain writes HEIC), so the
 * conversion itself is checked with a real iPhone photo through the release bundle; this checks
 * everything around it.
 */
describe('viewing a HEIC photo', () => {
	it('sends anything that is not HEIC as it is', async () => {
		const png = { filename: 'a.png', contentType: 'image/png', data: Buffer.from('png') };
		expect(await viewable('k1', png)).toBe(png);
	});

	it('sends a HEIC that cannot be converted as it is, so it downloads', async () => {
		const broken = { filename: 'IMG_1.HEIC', contentType: 'image/heic', data: Buffer.from('no') };
		expect(await viewable('k2', broken)).toBe(broken);
	});
});
