<!-- Card: a titled panel. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title?: string | undefined;
		children: Snippet;
		actions?: Snippet | undefined;
		tone?: 'plain' | 'warn' | 'bad';
	}

	let { title, children, actions, tone = 'plain' }: Props = $props();
</script>

<section class="card {tone}">
	{#if title !== undefined || actions !== undefined}
		<header>
			{#if title}<h2>{title}</h2>{/if}
			{#if actions}<div class="actions">{@render actions()}</div>{/if}
		</header>
	{/if}
	<div class="body">{@render children()}</div>
</section>

<style>
	.card {
		background: var(--colour-surface);
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
		padding: var(--space-5);
		display: grid;
		gap: var(--space-4);
		min-width: 0;
	}

	.warn {
		border-color: var(--colour-warn);
		background: var(--colour-warn-soft);
	}

	.bad {
		border-color: var(--colour-bad);
		background: var(--colour-bad-soft);
	}

	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.body {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
	}
</style>
