<!--
	ConfirmationHost: the window confirm() opens. Mounted once, in the root layout. Cancel, Esc
	and the close button all answer no.
-->
<script lang="ts">
	import Button from './button.svelte';
	import Modal from './modal.svelte';
	import { answer, confirmation } from '#lib/runes/confirm.svelte.ts';

	const current = $derived(confirmation.current);
	let typed = $state('');
	const matches = $derived(current?.match === undefined || typed.trim() === current.match);

	let field = $state<HTMLInputElement | null>(null);

	// Each question starts with nothing typed; the box to type in has the focus.
	$effect.pre(() => {
		if (current !== null) typed = '';
	});
	$effect(() => {
		field?.focus();
	});

	function yes(): void {
		if (matches) answer(typed.trim());
	}
</script>

<Modal
	open={current !== null}
	title={current?.title ?? ''}
	size="sm"
	onclose={() => {
		answer(null);
	}}
>
	{#if current !== null}
		<p class="message">{current.message}</p>
		{#if current.match !== undefined}
			<label class="field">
				<span>Type <strong>{current.match}</strong> to confirm.</span>
				<input
					bind:value={typed}
					autocomplete="off"
					bind:this={field}
					data-dirty-ignore
					onkeydown={(event) => {
						if (event.key === 'Enter') yes();
					}}
				/>
			</label>
		{/if}
	{/if}
	{#snippet footer()}
		<Button
			variant="secondary"
			onclick={() => {
				answer(null);
			}}>{current?.cancelText ?? 'Cancel'}</Button
		>
		<Button variant={current?.tone ?? 'primary'} disabled={!matches} onclick={yes}
			>{current?.confirmText ?? 'Confirm'}</Button
		>
	{/snippet}
</Modal>

<style>
	.message {
		margin: 0;
		white-space: pre-line;
	}

	.field {
		display: grid;
		gap: var(--space-1);
	}
</style>
