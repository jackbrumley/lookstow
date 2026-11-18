<!-- PageHeader: the page title, a line saying what the page is for, and its main actions. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		lede?: string | undefined;
		actions?: Snippet | undefined;
	}

	let { title, lede, actions }: Props = $props();
</script>

<header>
	<div>
		<h1>{title}</h1>
		{#if lede}<p class="muted">{lede}</p>{/if}
	</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>

<style>
	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: var(--space-4);
		flex-wrap: wrap;
	}

	p {
		margin-top: var(--space-1);
		max-width: 70ch;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
