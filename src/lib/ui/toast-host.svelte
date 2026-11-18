<!--
	ToastHost: shows the toasts. One in the root layout, and one inside each
	open Modal: a modal <dialog> sits above the whole page and makes it inert,
	so while one is open its own host shows them instead.
-->
<script lang="ts">
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { toast } from '#lib/runes/toast.svelte.ts';

	let { inModal = false }: { inModal?: boolean } = $props();
	const shown = $derived(inModal === toast.modalOpen);
</script>

<div class="host" aria-live="polite">
	{#each shown ? toast.messages : [] as message (message.id)}
		<div class="toast {message.tone}" role={message.tone === 'bad' ? 'alert' : 'status'}>
			<span>{message.text}</span>
			<button
				type="button"
				aria-label="Dismiss"
				onclick={() => {
					toast.dismiss(message.id);
				}}
			>
				<IconX size={16} />
			</button>
		</div>
	{/each}
</div>

<style>
	.host {
		position: fixed;
		right: var(--space-4);
		bottom: var(--space-4);
		display: grid;
		gap: var(--space-2);
		z-index: 50;
		max-width: min(28rem, calc(100vw - 2rem));
	}

	.toast {
		display: flex;
		gap: var(--space-3);
		align-items: flex-start;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		border: 1px solid var(--colour-border);
		background: var(--colour-surface);
	}

	.ok {
		border-left: 4px solid var(--colour-ok);
	}

	.bad {
		border-left: 4px solid var(--colour-bad);
	}

	.info {
		border-left: 4px solid var(--colour-info);
	}

	span {
		flex: 1;
	}

	button {
		border: none;
		background: none;
		color: var(--colour-text-muted);
		cursor: pointer;
		padding: 0;
		display: inline-flex;
	}
</style>
