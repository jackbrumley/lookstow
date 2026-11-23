<!--
	Modal: a dialog over the page (the browser's own <dialog>, so focus stays
	inside and Esc closes it). Clicking outside doesn't close it, so nothing
	typed is lost by accident. Bind `open` to show and hide it. `beforeclose` may refuse a close
	(an edit window with unsaved changes asks first).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import ToastHost from './toast-host.svelte';
	import { toast } from '#lib/runes/toast.svelte.ts';

	interface Props {
		open: boolean;
		title: string;
		size?: 'sm' | 'md' | 'lg';
		/** While true, Esc and the close button do nothing (e.g. while saving) */
		locked?: boolean;
		children: Snippet;
		footer?: Snippet | undefined;
		onclose?: (() => void) | undefined;
		/** Asked before Esc or the close button closes it; false keeps it open. */
		beforeclose?: (() => boolean | Promise<boolean>) | undefined;
	}

	let {
		open = $bindable(),
		title,
		size = 'md',
		locked = false,
		children,
		footer,
		onclose,
		beforeclose
	}: Props = $props();

	let dialog = $state<HTMLDialogElement | null>(null);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});

	// Toasts show inside the dialog while it's open (it covers the page)
	$effect(() => {
		return open ? toast.modalOpened() : undefined;
	});

	let asking = false;

	async function close(): Promise<void> {
		if (locked || asking) return;
		asking = true;
		try {
			if (beforeclose !== undefined && !(await beforeclose())) {
				// Kept open: show it again if the browser closed it meanwhile (below).
				if (open && dialog !== null && !dialog.open) dialog.showModal();
				return;
			}
		} finally {
			asking = false;
		}
		open = false;
		onclose?.();
	}

	// A browser may close a dialog on Esc even though its cancel was refused (Chromium does when
	// nothing was clicked since it opened). Treat that as a request to close: a locked window or
	// one whose question is answered "keep" comes back.
	function closedByBrowser(): void {
		if (!open || dialog === null || dialog.open) return;
		if (locked) dialog.showModal();
		else void close();
	}
</script>

<dialog
	bind:this={dialog}
	class={size}
	aria-labelledby="modal-title"
	oncancel={(e) => {
		e.preventDefault();
		void close();
	}}
	onclose={closedByBrowser}
>
	{#if open}
		<header>
			<h2 id="modal-title">{title}</h2>
			<button
				type="button"
				class="x"
				aria-label="Close"
				disabled={locked}
				onclick={() => void close()}
			>
				<IconX size={20} />
			</button>
		</header>
		<div class="body">{@render children()}</div>
		{#if footer}<footer>{@render footer()}</footer>{/if}
		<ToastHost inModal />
	{/if}
</dialog>

<style>
	dialog {
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		padding: 0;
		width: min(36rem, calc(100vw - 2rem));
		max-height: calc(100vh - 4rem);
		color: var(--colour-text);
		background: var(--colour-surface);
	}

	dialog.sm {
		width: min(28rem, calc(100vw - 2rem));
	}

	dialog.lg {
		width: min(56rem, calc(100vw - 2rem));
	}

	dialog[open] {
		display: flex;
		flex-direction: column;
	}

	dialog::backdrop {
		background: var(--colour-backdrop);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-5);
		border-bottom: 1px solid var(--colour-border);
	}

	h2 {
		margin: 0;
		font-size: var(--font-size-lg);
	}

	.x {
		background: none;
		border: none;
		color: var(--colour-text-muted);
		cursor: pointer;
		padding: var(--space-1);
		border-radius: var(--radius-sm);
		display: inline-flex;
	}

	.x:hover {
		background: var(--colour-surface-alt);
	}

	.body {
		padding: var(--space-5);
		overflow-y: auto;
		display: grid;
		gap: var(--space-4);
	}

	footer {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-5);
		border-top: 1px solid var(--colour-border);
		background: var(--colour-surface-alt);
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
	}
</style>
