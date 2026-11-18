<!-- Badge: a short status label. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	export type BadgeTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

	interface Props {
		children: Snippet;
		tone?: BadgeTone;
	}

	let { children, tone = 'neutral' }: Props = $props();
</script>

<span class="badge {tone}">{@render children()}</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0.125rem var(--space-2);
		border-radius: 999px;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		white-space: nowrap;
	}

	.ok {
		background: var(--colour-ok-soft);
		color: var(--colour-ok-text);
	}

	.warn {
		background: var(--colour-warn-soft);
		color: var(--colour-warn-text);
	}

	.bad {
		background: var(--colour-bad-soft);
		color: var(--colour-bad-text);
	}

	.info {
		background: var(--colour-info-soft);
		color: var(--colour-info-text);
	}

	.neutral {
		background: var(--colour-surface-alt);
		color: var(--colour-text-muted);
	}
</style>
