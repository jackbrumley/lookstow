<!-- A release's notes, drawn from parsed Markdown as components (never as HTML). -->
<script lang="ts">
	import { parseReleaseMarkdown, type Inline } from '#lib/domain/releases/release-markdown.ts';

	let { body }: { body: string } = $props();

	const blocks = $derived(parseReleaseMarkdown(body));
</script>

{#snippet inline(runs: Inline[])}
	{#each runs as run, index (index)}
		{#if run.kind === 'bold'}<strong>{run.text}</strong>
		{:else if run.kind === 'code'}<code>{run.text}</code>
		{:else if run.kind === 'link'}<a
				href={run.href}
				target="_blank"
				rel="external noopener noreferrer">{run.text}</a
			>
		{:else}{run.text}{/if}
	{/each}
{/snippet}

<div class="notes">
	{#each blocks as block, index (index)}
		{#if block.kind === 'heading'}
			{#if block.level === 2}<h3>{@render inline(block.content)}</h3>{:else}<h4>
					{@render inline(block.content)}
				</h4>{/if}
		{:else if block.kind === 'list'}
			<ul>
				{#each block.items as item, itemIndex (itemIndex)}<li>{@render inline(item)}</li>{/each}
			</ul>
		{:else}
			<p>{@render inline(block.content)}</p>
		{/if}
	{/each}
</div>

<style>
	.notes {
		display: grid;
		gap: var(--space-2);
	}

	h3,
	h4 {
		margin: var(--space-2) 0 0;
		font-size: var(--font-size-base);
	}

	ul {
		margin: 0;
		padding-left: var(--space-5);
	}
</style>
