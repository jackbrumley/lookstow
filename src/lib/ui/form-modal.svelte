<!--
	FormModal: a modal holding one form. Cancel or Esc closes it without
	saving. A refused action shows its message as a toast and the modal stays
	open with what was typed; a successful one closes the modal and the page
	shows the result as usual (toast, progress).

	The fields go in `children`. `actions`, when given, replaces the Cancel and
	submit buttons (for step-by-step forms); it gets the form's id (for a
	submit button's `form`) and whether it's busy.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import Button from './button.svelte';
	import Modal from './modal.svelte';
	import { isActionMessage } from '#lib/utils/form-toast.ts';
	import { toast } from '#lib/runes/toast.svelte.ts';

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

	const submit: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'failure') {
				toast.error(isActionMessage(result.data) ? result.data.message : 'That was refused.');
				return;
			}
			if (result.type === 'error') {
				toast.error(result.error instanceof Error ? result.error.message : 'Something went wrong.');
				return;
			}
			open = false;
			await update({ reset: false });
			onsuccess?.();
		};
	};
</script>

<Modal bind:open {title} {size} locked={busy}>
	<form method="POST" {action} use:enhance={submit} class="form" id={formId}>
		{@render children()}
	</form>
	{#snippet footer()}
		{#if actions}
			{@render actions({ formId, busy })}
		{:else}
			<Button variant="secondary" disabled={busy} onclick={() => (open = false)}>Cancel</Button>
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
