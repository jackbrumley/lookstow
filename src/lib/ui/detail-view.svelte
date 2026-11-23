<!--
	DetailView: a record's facts as label and value lines, in a view modal, card or page. The
	children are <dt> and <dd> pairs; a value may hold badges or links.

	<DetailView><dt>Username</dt><dd>ann</dd><dt>Status</dt><dd><Badge tone="ok">Active</Badge></dd></DetailView>
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<dl class="detail-view">{@render children()}</dl>

<style>
	.detail-view {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-2) var(--space-4);
		margin: 0;
	}

	.detail-view :global(dt) {
		color: var(--colour-text-muted);
	}

	.detail-view :global(dd) {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
</style>
