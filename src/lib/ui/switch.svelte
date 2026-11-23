<!--
	Switch: an on/off setting drawn as a row, the text on the left and the track on the right. It
	is a real checkbox underneath (sent with its form as "on" when on), so keyboards and screen
	readers treat it as one, named by its text.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** The setting's name, which is also the checkbox's accessible name. */
		children: Snippet;
		/** A line under the name saying what on means. */
		hint?: string | undefined;
		checked?: boolean;
		disabled?: boolean;
		name?: string | undefined;
	}

	let { children, hint, checked = $bindable(false), disabled = false, name }: Props = $props();
</script>

<label class="switch" class:disabled>
	<input type="checkbox" role="switch" {name} {disabled} bind:checked />
	<span class="text">
		<span class="label">{@render children()}</span>
		{#if hint}<span class="hint">{hint}</span>{/if}
	</span>
	<span class="state" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
	<span class="track" class:on={checked} aria-hidden="true"><span class="thumb"></span></span>
</label>

<style>
	.switch {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-md);
		background: var(--colour-surface);
		cursor: pointer;
		user-select: none;
	}

	.switch:hover:not(.disabled) {
		border-color: var(--colour-brand);
	}

	.switch:focus-within:not(.disabled) {
		border-color: var(--colour-brand);
		box-shadow: var(--focus-ring);
	}

	.disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	/* Hidden from sight, still focusable and announced. */
	input {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.text {
		display: grid;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}

	.label {
		font-weight: var(--font-weight-medium);
	}

	.hint {
		color: var(--colour-text-muted);
		font-size: var(--font-size-sm);
	}

	.state {
		color: var(--colour-text-muted);
		font-size: var(--font-size-sm);
		min-width: 1.75rem;
		text-align: right;
	}

	.track {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		width: 40px;
		height: 22px;
		padding: 2px;
		box-sizing: border-box;
		border-radius: 999px;
		background: var(--colour-border-strong);
		transition: background-color 0.2s ease;
	}

	.track.on {
		background: var(--colour-brand);
	}

	.thumb {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--colour-surface);
		box-shadow: var(--shadow-sm);
		transition: transform 0.2s ease;
	}

	.on .thumb {
		transform: translateX(18px);
	}
</style>
