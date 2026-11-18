/** One line of the service log, as the Log page shows it (browser-safe). */
export type LogLine = {
	/** Increases by one per line since the service started; the page asks for lines after it. */
	seq: number;
	at: string;
	level: 'info' | 'warn' | 'error';
	area: string;
	message: string;
};
