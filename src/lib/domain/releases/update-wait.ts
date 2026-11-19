/** How long an update usually takes, start to reload (about three minutes on a real server). */
const USUAL_UPDATE_MS = 3 * 60_000;

/**
 * The countdown while Lookstow updates: the time left of the usual three minutes, then a plain
 * word that it is taking longer, since the page reloads by itself either way.
 */
export function updateWaitLine(elapsedMs: number): string {
	const left = Math.ceil((USUAL_UPDATE_MS - Math.max(0, elapsedMs)) / 1000);
	if (left <= 0) return 'Taking a little longer than usual';
	const minutes = Math.floor(left / 60);
	const seconds = left % 60;
	if (minutes === 0) {
		return seconds === 1 ? 'About 1 second left' : `About ${String(seconds)} seconds left`;
	}
	if (seconds === 0) {
		return minutes === 1 ? 'About 1 minute left' : `About ${String(minutes)} minutes left`;
	}
	return `About ${String(minutes)} min ${String(seconds)} s left`;
}
