/**
 * Zoom maths for the picture lightbox (ui/lightbox.svelte): pure, so tested on their own.
 * After Midfield AI's media lightbox.
 */
export type ZoomLimits = { minZoom: number; maxZoom: number };

/** Wheel factor per notch, in and out. */
const WHEEL_IN = 1.15;
const WHEEL_OUT = 0.87;
/** The smallest change a button press makes. */
const MIN_BUTTON_STEP = 0.1;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Rounds to two decimal places and keeps the zoom within its limits. */
export function clampZoom(value: number, limits: ZoomLimits): number {
	return Math.min(limits.maxZoom, Math.max(limits.minZoom, round2(value)));
}

/** One step in: multiply by `step`, but move at least 10%. */
export function zoomInStep(current: number, step: number, limits: ZoomLimits): number {
	return clampZoom(Math.max(current + MIN_BUTTON_STEP, current * step), limits);
}

/** One step out: divide by `step`, but move at least 10%. */
export function zoomOutStep(current: number, step: number, limits: ZoomLimits): number {
	return clampZoom(Math.min(current - MIN_BUTTON_STEP, current / step), limits);
}

/** The zoom after one wheel notch (a negative deltaY zooms in). */
export function wheelZoom(current: number, deltaY: number, limits: ZoomLimits): number {
	return clampZoom(current * (deltaY < 0 ? WHEEL_IN : WHEEL_OUT), limits);
}

/** The zoom during a pinch, from the zoom and finger distance when it started. */
export function pinchZoom(
	startZoom: number,
	startDistance: number,
	currentDistance: number,
	limits: ZoomLimits
): number {
	if (startDistance <= 0) return startZoom;
	return clampZoom(startZoom * (currentDistance / startDistance), limits);
}

/** Whether a pointer has moved far enough from where it pressed to count as a drag. */
export function isDrag(dx: number, dy: number): boolean {
	return Math.abs(dx) > 4 || Math.abs(dy) > 4;
}

/** A quarter turn clockwise (1) or anticlockwise (-1) from `degrees`, kept to 0, 90, 180 or 270. */
export function turn(degrees: number, by: 1 | -1): number {
	return (((degrees + by * 90) % 360) + 360) % 360;
}

/** The picture before or after this one, going round at either end. */
export function stepIndex(index: number, count: number, by: 1 | -1): number {
	if (count <= 0) return 0;
	return (index + by + count) % count;
}
