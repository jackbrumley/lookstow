<!-- EmptyState: what a list or section shows when there is nothing in it yet. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title?: string | undefined;
		description?: string | undefined;
		/** A button to make the first one. */
		action?: Snippet | undefined;
	}

	let { title, description, action }: Props = $props();
</script>

<div class="empty">
	{#if title}<strong>{title}</strong>{/if}
	{#if description}<p>{description}</p>{/if}
	{#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
	.empty {
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		padding: var(--space-5) var(--space-4);
		border: 1px dashed var(--colour-border-strong);
		border-radius: var(--radius-md);
		color: var(--colour-text-muted);
		text-align: center;
	}

	.empty strong {
		color: var(--colour-text);
	}

	.empty p {
		margin: 0;
	}
</style>
