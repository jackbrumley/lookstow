<script lang="ts">
	/**
	 * A wait that owns the whole screen: the sidebar and the page are covered and only this card
	 * shows. For a wait where nothing else can be used, such as Lookstow restarting into a new
	 * version, so nobody starts something the restart would cut off.
	 */
	let { title, detail, note }: { title: string; detail: string; note: string } = $props();
</script>

<div class="screen" role="status" aria-live="polite">
	<div class="card">
		<div class="spinner" aria-hidden="true"></div>
		<h1>{title}</h1>
		<p>{detail}</p>
		{#if note !== ''}<p class="note">{note}</p>{/if}
	</div>
</div>

<style>
	/* Above the console and its dialogs, below toasts (50). */
	.screen {
		position: fixed;
		inset: 0;
		z-index: 40;
		display: grid;
		place-items: center;
		padding: var(--space-6);
		background: var(--colour-bg);
	}

	.card {
		max-width: 32rem;
		padding: var(--space-8);
		text-align: center;
		background: var(--colour-surface);
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-lg);
	}

	h1 {
		margin: var(--space-4) 0 var(--space-2);
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
		line-height: var(--line-height-tight);
	}

	p {
		margin: 0;
		color: var(--colour-text);
	}

	.note {
		margin-top: var(--space-3);
		font-size: var(--font-size-sm);
		color: var(--colour-text-muted);
	}

	.spinner {
		width: 2.5rem;
		height: 2.5rem;
		margin: 0 auto;
		border: 3px solid var(--colour-brand-soft);
		border-top-color: var(--colour-brand);
		border-radius: 50%;
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 3s;
		}
	}
</style>
