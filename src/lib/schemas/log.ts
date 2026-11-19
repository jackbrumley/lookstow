import { z } from 'zod';

/** One line of the service log, as the Log page shows it. */
export const logLineSchema = z.strictObject({
	/** Increases by one per line since the service started; the page asks for lines after it. */
	seq: z.int().nonnegative(),
	at: z.string(),
	level: z.enum(['info', 'warn', 'error']),
	area: z.string(),
	message: z.string()
});
export type LogLine = z.infer<typeof logLineSchema>;

/** GET /api/log's reply: the lines after the number the page asked for. */
export const logReplySchema = z.strictObject({ lines: z.array(logLineSchema) });
