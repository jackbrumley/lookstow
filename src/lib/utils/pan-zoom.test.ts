import { describe, expect, it } from 'vitest';
import {
	clampZoom,
	isDrag,
	pinchZoom,
	stepIndex,
	turn,
	wheelZoom,
	zoomInStep,
	zoomOutStep
} from './pan-zoom.ts';

const LIMITS = { minZoom: 0.1, maxZoom: 20 };

describe('zooming a picture', () => {
	it('steps in and out by at least 10%, within its limits', () => {
		expect(zoomInStep(1, 1.25, LIMITS)).toBe(1.25);
		expect(zoomInStep(0.2, 1.25, LIMITS)).toBe(0.3);
		expect(zoomOutStep(1, 1.25, LIMITS)).toBe(0.8);
		expect(zoomOutStep(0.15, 1.25, LIMITS)).toBe(0.1);
		expect(zoomInStep(19.9, 1.25, LIMITS)).toBe(20);
		expect(clampZoom(0.012, LIMITS)).toBe(0.1);
	});

	it('follows the wheel and a pinch', () => {
		expect(wheelZoom(1, -100, LIMITS)).toBe(1.15);
		expect(wheelZoom(1, 100, LIMITS)).toBe(0.87);
		expect(pinchZoom(1, 100, 200, LIMITS)).toBe(2);
		expect(pinchZoom(1, 0, 200, LIMITS)).toBe(1);
	});

	it('counts a press as a drag only once it moves a few pixels', () => {
		expect(isDrag(3, -4)).toBe(false);
		expect(isDrag(5, 0)).toBe(true);
		expect(isDrag(0, -5)).toBe(true);
	});
});

describe('rotating and moving between pictures', () => {
	it('turns a quarter at a time, either way, round to upright', () => {
		expect(turn(0, 1)).toBe(90);
		expect(turn(270, 1)).toBe(0);
		expect(turn(0, -1)).toBe(270);
		expect(turn(90, -1)).toBe(0);
	});

	it('goes round at either end', () => {
		expect(stepIndex(0, 3, 1)).toBe(1);
		expect(stepIndex(2, 3, 1)).toBe(0);
		expect(stepIndex(0, 3, -1)).toBe(2);
		expect(stepIndex(0, 0, 1)).toBe(0);
	});
});
