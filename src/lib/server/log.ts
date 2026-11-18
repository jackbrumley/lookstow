/**
 * The service log: one line per event on standard output, which the launcher sends to
 * journald (Linux) or server.log (Windows). `[time] LEVEL area: message`, so a line still
 * makes sense when copied out of context.
 */
export type LogLevel = 'info' | 'warn' | 'error';

export function serverLog(level: LogLevel, area: string, message: string): void {
	const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${area}: ${message}\n`;
	if (level === 'error') {
		process.stderr.write(line);
	} else {
		process.stdout.write(line);
	}
}

/** An error's message for a log line or the console, with its cause when it has one. */
export function errorText(error: unknown): string {
	if (error instanceof Error) {
		const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
		return `${error.message}${cause}`;
	}
	return String(error);
}
