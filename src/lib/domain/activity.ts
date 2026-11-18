/** Browser-safe shapes for the Activity page and the dashboard. */
export type ActivityLevel = 'info' | 'warn' | 'error';

export type ActivityEntry = {
	id: string;
	at: string;
	level: ActivityLevel;
	kind: string;
	actor: string;
	summary: string;
	detail: string | null;
	mailboxId: string | null;
};
