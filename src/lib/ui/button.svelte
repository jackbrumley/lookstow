<!-- Button: the standard action button. A link when `href` is given. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ResolvedPathname } from '$app/types';

	interface Props {
		children: Snippet;
		variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
		size?: 'sm' | 'md';
		type?: 'button' | 'submit';
		disabled?: boolean;
		/** Renders the button as a link. From resolve(). */
		href?: ResolvedPathname | undefined;
		name?: string | undefined;
		value?: string | undefined;
		title?: string | undefined;
		/** Submits the form to a different action */
		formaction?: string | undefined;
		/** The id of the form it submits, when it's outside it (e.g. a modal's footer) */
		form?: string | undefined;
		onclick?: ((event: MouseEvent) => void) | undefined;
	}

	let {
		children,
		variant = 'primary',
		size = 'md',
		type = 'button',
		disabled = false,
		href,
		name,
		value,
		title,
		formaction,
		form,
		onclick
	}: Props = $props();
</script>

{#if href !== undefined && !disabled}
	<a {href} {title} class="button {variant} {size}">{@render children()}</a>
{:else}
	<button
		{type}
		{disabled}
		{name}
		{value}
		{title}
		{formaction}
		{form}
		class="button {variant} {size}"
		{onclick}
	>
		{@render children()}
	</button>
{/if}

<style>
	.button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		border-radius: var(--radius-md);
		font: inherit;
		font-weight: var(--font-weight-medium);
		text-decoration: none;
		cursor: pointer;
		border: 1px solid transparent;
		white-space: nowrap;
		transition:
			background 0.15s ease,
			border-color 0.15s ease;
	}

	.button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.md {
		min-height: 2.5rem;
		padding: var(--space-2) var(--space-4);
	}

	.sm {
		min-height: 2rem;
		padding: var(--space-1) var(--space-3);
		font-size: var(--font-size-sm);
	}

	.primary {
		background: var(--colour-brand);
		color: var(--colour-text-inverse);
	}

	.primary:hover:not(:disabled) {
		background: var(--colour-brand-hover);
	}

	.secondary {
		background: var(--colour-surface);
		color: var(--colour-text);
		border-color: var(--colour-border-strong);
	}

	.secondary:hover:not(:disabled) {
		background: var(--colour-surface-alt);
	}

	.danger {
		background: var(--colour-bad);
		color: #ffffff;
	}

	.danger:hover:not(:disabled) {
		background: var(--colour-bad-hover);
	}

	.ghost {
		background: transparent;
		color: var(--colour-brand);
	}

	.ghost:hover:not(:disabled) {
		background: var(--colour-brand-soft);
	}
</style>
