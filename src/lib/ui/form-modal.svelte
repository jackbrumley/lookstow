<!--
	FormModal: a modal holding one form. Cancel or Esc closes it without
	saving. A refused action shows its message as a toast and the modal stays
	open with what was typed; a successful one closes the modal and the page
	shows the result as usual (toast, progress). Closing it after changing a field asks first, so
	nothing typed is thrown away by a stray Esc.

	The fields go in `children`. `actions`, when given, replaces the Cancel and
	submit buttons (for step-by-step forms); it gets the form's id (for a
	submit button's `form`) and whether it's busy.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import Button from './button.svelte';
	import Modal from './modal.svelte';
	import { settleAction } from '#lib/utils/form-toast.ts';
	import { confirm } from '#lib/runes/confirm.svelte.ts';
	import { trackChanges } from './dirty-tracker.ts';

	interface Props {
		open: boolean;
		title: string;
		/** The form action, e.g. ?/save */
		action: string;
		submitLabel?: string;
		busyLabel?: string;
		variant?: 'primary' | 'danger';
		size?: 'md' | 'lg';
		/** The submit button is enabled */
		canSubmit?: boolean;
		children: Snippet;
		actions?: Snippet<[{ formId: string; busy: boolean }]> | undefined;
		onsuccess?: (() => void) | undefined;
	}

	let {
		open = $bindable(),
		title,
		action,
		submitLabel = 'Save',
		busyLabel = 'Working…',
		variant = 'primary',
		size = 'md',
		canSubmit = true,
		children,
		actions,
		onsuccess
	}: Props = $props();

	const uid = $props.id();
	const formId = `form-${uid}`;
	let busy = $state(false);

	let form = $state<HTMLFormElement | null>(null);
	let changed: () => boolean = () => false;

	// Watches the fields while the window is open (the form is drawn only then).
	$effect(() => {
		if (form === null) return;
		const tracker = trackChanges(form);
		changed = () => tracker.isDirty();
		return () => {
			tracker.stop();
			changed = () => false;
		};
	});

	/** Whether the window may close: yes, unless something was changed and the person keeps it. */
	async function mayClose(): Promise<boolean> {
		if (!changed()) return true;
		return confirm({
			title: 'Discard your changes?',
			message: `What you changed in “${title}” is not saved.`,
			confirmText: 'Discard changes',
			cancelText: 'Keep editing',
			tone: 'danger'
		});
	}

	async function cancel(): Promise<void> {
		if (await mayClose()) open = false;
	}

	const submit: SubmitFunction = () => {
		busy = true;
		return async (answered) => {
			const ok = await settleAction(answered);
			busy = false;
			if (!ok) return;
			open = false;
			onsuccess?.();
		};
	};
</script>

<Modal bind:open {title} {size} locked={busy} beforeclose={mayClose}>
	<form method="POST" {action} use:enhance={submit} class="form" id={formId} bind:this={form}>
		{@render children()}
	</form>
	{#snippet footer()}
		{#if actions}
			{@render actions({ formId, busy })}
		{:else}
			<Button variant="secondary" disabled={busy} onclick={() => void cancel()}>Cancel</Button>
			<Button type="submit" {variant} disabled={busy || !canSubmit} form={formId}
				>{busy ? busyLabel : submitLabel}</Button
			>
		{/if}
	{/snippet}
</Modal>

<style>
	.form {
		display: grid;
		gap: var(--space-4);
	}

	/* Fields inside a modal form: label above, full width */
	.form :global(label.field) {
		display: grid;
		gap: var(--space-1);
	}

	.form :global(label.check) {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		font-weight: var(--font-weight-normal);
	}

	.form :global(.hint) {
		margin: 0;
		color: var(--colour-text-muted);
		font-size: var(--font-size-sm);
	}
</style>
