/**
 * Shows the outcome of a form action as a toast. Actions return
 * `{ ok, message }` (or `fail(status, { ok: false, message })`).
 */
import { toast } from '../runes/toast.svelte.ts';

export interface ActionMessage {
	ok: boolean;
	message: string;
}

export function isActionMessage(value: unknown): value is ActionMessage {
	return (
		typeof value === 'object' &&
		value !== null &&
		'ok' in value &&
		'message' in value &&
		typeof value.ok === 'boolean' &&
		typeof value.message === 'string'
	);
}

let lastShown: unknown = null;

/** Call from an $effect with the page's `form` prop; each result is shown once */
export function toastFormResult(form: unknown): void {
	if (!isActionMessage(form) || form === lastShown) return;
	lastShown = form;
	if (form.ok) toast.success(form.message);
	else toast.error(form.message);
}
