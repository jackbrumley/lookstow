<!--
	Callout: a coloured note in a page, card or modal: info, warning, danger or success. A danger
	callout is announced to screen readers. Use it for anything that needs noticing, never an
	ad-hoc coloured paragraph.

	<Callout tone="warning">Remote access is off, so none of these accounts can sign in.</Callout>
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		tone: 'info' | 'warning' | 'danger' | 'success';
		children: Snippet;
	}

	let { tone, children }: Props = $props();
</script>

<div class="callout {tone}" role={tone === 'danger' ? 'alert' : undefined}>
	{@render children()}
</div>

<style>
	.callout {
		padding: var(--space-2) var(--space-3);
		border-left: 4px solid;
		border-radius: var(--radius-sm);
		overflow-wrap: anywhere;
	}

	.callout :global(p) {
		margin: 0;
	}

	.info {
		border-color: var(--colour-info);
		background: var(--colour-info-soft);
		color: var(--colour-info-text);
	}

	.warning {
		border-color: var(--colour-warn);
		background: var(--colour-warn-soft);
		color: var(--colour-warn-text);
	}

	.danger {
		border-color: var(--colour-bad);
		background: var(--colour-bad-soft);
		color: var(--colour-bad-text);
	}

	.success {
		border-color: var(--colour-ok);
		background: var(--colour-ok-soft);
		color: var(--colour-ok-text);
	}
</style>
