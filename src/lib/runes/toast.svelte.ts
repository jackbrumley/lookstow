/**
 * Toast notifications: the outcome of an action. Shown by the one ToastHost
 * in the root layout.
 */
import { untrack } from 'svelte';

export interface ToastMessage {
	id: number;
	tone: 'ok' | 'bad' | 'info';
	text: string;
}

let messages = $state<ToastMessage[]>([]);
let nextId = 1;
/** Modals open now: while any is, the toasts show inside it */
let modals = $state(0);

function add(tone: ToastMessage['tone'], text: string, ms: number | null): void {
	const id = nextId++;
	messages = [...messages, { id, tone, text }];
	if (ms !== null) {
		setTimeout(() => {
			toast.dismiss(id);
		}, ms);
	}
}

export const toast = {
	get messages(): readonly ToastMessage[] {
		return messages;
	},
	success: (text: string): void => {
		add('ok', text, 5000);
	},
	info: (text: string): void => {
		add('info', text, 6000);
	},
	/** Stays until dismissed */
	error: (text: string): void => {
		add('bad', text, null);
	},
	dismiss: (id: number) => {
		messages = messages.filter((m) => m.id !== id);
	},
	get modalOpen(): boolean {
		return modals > 0;
	},
	/**
	 * Called from Modal's effect while it's open; returns the function to call
	 * when it closes. Untracked: reading the count there would re-run the
	 * effect on its own change, forever.
	 */
	modalOpened: (): (() => void) => {
		untrack(() => modals++);
		return () => {
			untrack(() => modals--);
		};
	}
};
