/**
 * Shows the outcome of a form action as a toast. Actions return
 * `{ ok, message }` (or `fail(status, { ok: false, message })`).
 */
import type { ActionResult } from '$app/forms';
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

/** What an enhanced form gets back once its action has answered. */
interface Answered {
	result: ActionResult;
	update: (options?: { reset?: boolean }) => Promise<void>;
}

/**
 * The end of every enhanced form in a window (FormModal, ConfirmForm): a refusal shows as a toast
 * and nothing else changes, so what was typed stays; success updates the page, whose own form
 * result shows its toast. Resolves true on success.
 */
export async function settleAction({ result, update }: Answered): Promise<boolean> {
	if (result.type === 'failure') {
		toast.error(isActionMessage(result.data) ? result.data.message : 'That was refused.');
		return false;
	}
	if (result.type === 'error') {
		toast.error(result.error instanceof Error ? result.error.message : 'Something went wrong.');
		return false;
	}
	await update({ reset: false });
	return true;
}
