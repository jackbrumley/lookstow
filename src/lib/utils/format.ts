/** Formatting the console uses everywhere: sizes, counts and times, in plain words. */

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = unit === 0 || value >= 100 ? 0 : 1;
	return `${value.toFixed(digits)} ${UNITS[unit] ?? 'bytes'}`;
}

export function formatCount(count: number): string {
	return count.toLocaleString('en-AU');
}

/**
 * Times are shown in one time zone for everyone: that of the computer Lookstow runs on (the root
 * layout sets it from the server), so the page the server draws and the browser agree, and a
 * message's time never shows in UTC or another sender's zone.
 */
let displayZone: string | undefined;

export function setDisplayTimeZone(zone: string): void {
	displayZone = zone;
}

/** A date and time, e.g. "9 Jul 2020, 8:59 am"; `withZone` adds the zone, e.g. "AEST". */
export function formatDateTime(iso: string | null, withZone = false): string {
	if (iso === null) {
		return 'never';
	}
	const when = new Date(iso);
	const text = when.toLocaleString('en-AU', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: displayZone
	});
	if (!withZone) return text;
	const zone = new Intl.DateTimeFormat('en-AU', { timeZone: displayZone, timeZoneName: 'short' })
		.formatToParts(when)
		.find((part) => part.type === 'timeZoneName')?.value;
	return zone === undefined ? text : `${text} ${zone}`;
}

/** A time of day with seconds, e.g. "4:21:07 pm", for logs. */
export function formatTimeOfDay(iso: string): string {
	return new Date(iso).toLocaleTimeString('en-AU', { timeZone: displayZone });
}

/** "3 minutes ago", "in 2 hours": for times near now. */
export function formatRelative(iso: string | null, now = Date.now()): string {
	if (iso === null) {
		return 'never';
	}
	const diff = new Date(iso).getTime() - now;
	const minutes = Math.round(Math.abs(diff) / 60_000);
	let text: string;
	if (minutes < 1) {
		return diff > 0 ? 'in under a minute' : 'just now';
	} else if (minutes < 60) {
		text = `${minutes} minute${minutes === 1 ? '' : 's'}`;
	} else if (minutes < 48 * 60) {
		const hours = Math.round(minutes / 60);
		text = `${hours} hour${hours === 1 ? '' : 's'}`;
	} else {
		const days = Math.round(minutes / 1440);
		text = `${days} day${days === 1 ? '' : 's'}`;
	}
	return diff > 0 ? `in ${text}` : `${text} ago`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${formatCount(count)} ${count === 1 ? one : many}`;
}

export function formatPercent(percent: number | null): string {
	return percent === null ? 'unknown' : `${percent.toFixed(percent >= 99 ? 1 : 0)}%`;
}
