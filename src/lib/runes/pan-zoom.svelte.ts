import {
	clampZoom,
	isDrag,
	pinchZoom,
	turn,
	wheelZoom,
	zoomInStep,
	zoomOutStep,
	type ZoomLimits
} from '../utils/pan-zoom.ts';

/**
 * Pan and zoom for the picture lightbox (ui/lightbox.svelte): mouse drag, the wheel, one-finger
 * pan and two-finger pinch. After Midfield AI's media lightbox.
 */
type Point = { x: number; y: number };

const LIMITS: ZoomLimits = { minZoom: 0.1, maxZoom: 20 };
const STEP = 1.25;

function distance(a: Touch, b: Touch): number {
	return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}

export class PanZoom {
	zoom = $state(1);
	panX = $state(0);
	panY = $state(0);
	dragging = $state(false);
	/** Quarter turns clockwise: 0, 90, 180 or 270 degrees. */
	rotation = $state(0);
	/** The last press moved the picture, so its release is not a click outside it. */
	moved = false;

	#start: Point = { x: 0, y: 0 };
	#pinchFrom: number | null = null;
	#pinchZoom = 1;

	get transform(): string {
		return `translate(${String(this.panX)}px, ${String(this.panY)}px) rotate(${String(this.rotation)}deg) scale(${String(this.zoom)})`;
	}

	/** On its side (90 or 270 degrees), so it is fitted with width and height swapped. */
	get sideways(): boolean {
		return this.rotation % 180 !== 0;
	}

	rotateRight = (): void => {
		this.rotation = turn(this.rotation, 1);
	};

	rotateLeft = (): void => {
		this.rotation = turn(this.rotation, -1);
	};

	/** Back to how a picture first opens: fitted, centred and upright. */
	resetAll = (): void => {
		this.reset();
		this.rotation = 0;
	};

	zoomIn = (): void => {
		this.zoom = zoomInStep(this.zoom, STEP, LIMITS);
	};

	zoomOut = (): void => {
		this.zoom = zoomOutStep(this.zoom, STEP, LIMITS);
	};

	reset = (): void => {
		this.zoom = clampZoom(1, LIMITS);
		this.panX = 0;
		this.panY = 0;
		this.moved = false;
	};

	wheel = (event: WheelEvent): void => {
		event.preventDefault();
		this.zoom = wheelZoom(this.zoom, event.deltaY, LIMITS);
	};

	mouseDown = (event: MouseEvent): void => {
		if (event.button !== 0) return;
		event.preventDefault();
		this.#begin(event.clientX, event.clientY);
	};

	mouseMove = (event: MouseEvent): void => {
		if (this.dragging) this.#move(event.clientX, event.clientY);
	};

	mouseUp = (): void => {
		this.dragging = false;
	};

	touchStart = (event: TouchEvent): void => {
		const [first, second] = event.touches;
		if (event.touches.length === 1 && first !== undefined) {
			this.#begin(first.clientX, first.clientY);
			this.#pinchFrom = null;
		} else if (event.touches.length === 2 && first !== undefined && second !== undefined) {
			this.dragging = true;
			this.moved = true;
			this.#pinchFrom = distance(first, second);
			this.#pinchZoom = this.zoom;
		}
	};

	touchMove = (event: TouchEvent): void => {
		if (!this.dragging) return;
		const [first, second] = event.touches;
		if (event.touches.length === 1 && first !== undefined && this.#pinchFrom === null) {
			this.#move(first.clientX, first.clientY);
		} else if (
			event.touches.length === 2 &&
			first !== undefined &&
			second !== undefined &&
			this.#pinchFrom !== null
		) {
			this.zoom = pinchZoom(this.#pinchZoom, this.#pinchFrom, distance(first, second), LIMITS);
		}
	};

	touchEnd = (event: TouchEvent): void => {
		const [first] = event.touches;
		if (event.touches.length === 0) {
			this.dragging = false;
			this.#pinchFrom = null;
		} else if (event.touches.length === 1 && first !== undefined) {
			// From a pinch back to one finger.
			this.#start = { x: first.clientX - this.panX, y: first.clientY - this.panY };
			this.#pinchFrom = null;
		}
	};

	/** Whether a click on the backdrop should close: not at the end of a drag. */
	clickedOutside = (): boolean => {
		if (this.moved) {
			this.moved = false;
			return false;
		}
		return true;
	};

	#begin(x: number, y: number): void {
		this.dragging = true;
		this.moved = false;
		this.#start = { x: x - this.panX, y: y - this.panY };
	}

	#move(x: number, y: number): void {
		if (isDrag(x - this.panX - this.#start.x, y - this.panY - this.#start.y)) this.moved = true;
		this.panX = x - this.#start.x;
		this.panY = y - this.#start.y;
	}
}
