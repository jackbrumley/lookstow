<!--
	ConfirmForm: a button that asks first (the confirm() window), then sends its form action. For
	actions with nothing to fill in (remove, delete, make a new certificate). A question with
	`match` makes the person type that text, which is sent as the field `confirm` for the server
	to check again. A refusal shows as a toast; success updates the page as usual.

	<ConfirmForm action="?/remove" fields={{ id }} question={{ title, message, confirmText: 'Remove',
		tone: 'danger' }} variant="danger">Remove…</ConfirmForm>
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import Button from './button.svelte';
	import { ask, type Question } from '#lib/runes/confirm.svelte.ts';
	import { settleAction } from '#lib/utils/form-toast.ts';

	interface Props {
		/** The form action, e.g. ?/remove */
		action: string;
		/** Sent with it, as hidden fields. */
		fields?: Record<string, string>;
		question: Question;
		children: Snippet;
		variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
		size?: 'sm' | 'md';
		disabled?: boolean;
		title?: string | undefined;
		onsuccess?: (() => void) | undefined;
	}

	let {
		action,
		fields = {},
		question,
		children,
		variant = 'secondary',
		size = 'md',
		disabled = false,
		title,
		onsuccess
	}: Props = $props();

	let busy = $state(false);

	const submit: SubmitFunction = async ({ cancel, formData }) => {
		const typed = await ask(question);
		if (typed === null) {
			cancel();
			return;
		}
		if (question.match !== undefined) formData.set('confirm', typed);
		busy = true;
		return async (answered) => {
			const ok = await settleAction(answered);
			busy = false;
			if (ok) onsuccess?.();
		};
	};
</script>

<form method="POST" {action} use:enhance={submit}>
	{#each Object.entries(fields) as [name, value] (name)}
		<input type="hidden" {name} {value} />
	{/each}
	<Button type="submit" {variant} {size} {title} disabled={disabled || busy}
		>{@render children()}</Button
	>
</form>

<style>
	form {
		display: contents;
	}
</style>
