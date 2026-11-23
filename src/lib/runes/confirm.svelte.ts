/**
 * Asking before an action (deleting, removing, discarding changes): `confirm()` opens the one
 * confirmation window, shown by the ConfirmationHost in the root layout, and resolves with the
 * answer. With `match`, the person types that text before the button unlocks (for what cannot be
 * undone), and the promise resolves with what was typed.
 *
 * @example
 * if (await confirm({ title: 'Remove Ann?', message: '…', confirmText: 'Remove', tone: 'danger' })) …
 */
import { untrack } from 'svelte';

export interface Question {
	title: string;
	message: string;
	/** The button that says yes. Default "Confirm". */
	confirmText?: string;
	/** Default "Cancel". */
	cancelText?: string;
	/** Default "primary". */
	tone?: 'primary' | 'danger';
	/** Text to type before the button unlocks. */
	match?: string;
}

interface Asking extends Question {
	settle: (answer: string | null) => void;
}

let asking = $state<Asking | null>(null);

/** The question the host shows, or null. */
export const confirmation = {
	get current(): Asking | null {
		return asking;
	}
};

/**
 * Asks, and resolves with the answer: null when the person cancels, else what they typed ("" when
 * there was nothing to type). A new question cancels one already open.
 */
export function ask(question: Question): Promise<string | null> {
	// Untracked, as in the toast rune: asking from an $effect must not make it depend on this.
	untrack(() => asking)?.settle(null);
	return new Promise((resolve) => {
		asking = { ...question, settle: resolve };
	});
}

/** Asks a yes-or-no question; true for yes. */
export async function confirm(question: Question): Promise<boolean> {
	return (await ask(question)) !== null;
}

/** Closes the question: what was typed (or "") for yes, null for no. */
export function answer(value: string | null): void {
	const current = untrack(() => asking);
	if (current === null) return;
	asking = null;
	current.settle(value);
}
