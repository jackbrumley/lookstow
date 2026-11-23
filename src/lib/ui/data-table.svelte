<!--
	DataTable: every list of records in Lookstow. A row can open something, in one of three ways:
	- `onopen`: the first cell is a button stretched over the whole row (opens a view window);
	- `href`: the first cell is a link stretched over the whole row (opens a page);
	- a link of the caller's own anywhere in `cells`, given the class `row-link`, is stretched
	  the same way (when the link is not in the first column, or only some rows have one).
	Without any of them it is a plain list. Either way there is one real link or button per row,
	so it works by mouse, keyboard and screen reader alike. Buttons, forms and other links in a
	row sit above the stretched one and work as usual.
-->
<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import EmptyState from './empty-state.svelte';
	import type { ResolvedPathname } from '$app/types';

	interface Props {
		/** The column headings, the first being the label's column when the row opens something. */
		columns?: string[];
		/** Heading cells (<th>s) of the caller's own, in place of `columns` (e.g. sortable ones). */
		head?: Snippet | undefined;
		rows: readonly T[];
		key: (row: T) => string;
		/** The first cell's text, when the row opens something (`onopen` or `href`). */
		label?: ((row: T) => string) | undefined;
		/** The row opens a window: the first cell is a button. */
		onopen?: ((row: T) => void) | undefined;
		/** The row opens a page: the first cell is a link. */
		href?: ((row: T) => ResolvedPathname) | undefined;
		/** More in the first cell, after the label (a second line, a badge). */
		first?: Snippet<[T]> | undefined;
		/** The cells, as <td>s: those after the first when the row opens something, else all. */
		cells: Snippet<[T]>;
		/** Shown in place of the table when there are no rows. */
		empty?: string;
		/** Smaller text, for long lists of small facts (an audit trail). */
		compact?: boolean;
	}

	let {
		columns = [],
		head,
		rows,
		key,
		label,
		onopen,
		href,
		first,
		cells,
		empty = 'Nothing here yet.',
		compact = false
	}: Props = $props();

	const opens = $derived(onopen !== undefined || href !== undefined);
</script>

{#if rows.length === 0}
	<EmptyState description={empty} />
{:else}
	<div class="wrap">
		<table class:compact>
			<thead>
				<tr>
					{#if head}
						{@render head()}
					{:else}
						{#each columns as column, index (index)}<th>{column}</th>{/each}
					{/if}
				</tr>
			</thead>
			<tbody>
				{#each rows as row (key(row))}
					<tr class:opens>
						{#if onopen !== undefined}
							<td>
								<button
									type="button"
									class="row-link open"
									onclick={() => {
										onopen(row);
									}}>{label?.(row) ?? key(row)}</button
								>
								{@render first?.(row)}
							</td>
						{:else if href !== undefined}
							<td>
								<a class="row-link open" href={href(row)}>{label?.(row) ?? key(row)}</a>
								{@render first?.(row)}
							</td>
						{/if}
						{@render cells(row)}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	.wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	tr > :global(td) {
		text-align: left;
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--colour-border);
		vertical-align: middle;
	}

	th {
		color: var(--colour-text-muted);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
	}

	.compact tr > :global(td) {
		font-size: var(--font-size-sm);
		padding-block: var(--space-1);
	}

	tbody tr {
		position: relative;
	}

	tbody tr.opens:hover,
	tbody tr:has(:global(.row-link)):hover {
		background: var(--colour-surface-alt);
	}

	.open {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-weight: var(--font-weight-semibold);
		color: var(--colour-brand);
		cursor: pointer;
		text-align: left;
		text-decoration: none;
	}

	/* The row's link or button covers the row, so anywhere on it opens the record. */
	tbody :global(.row-link)::after {
		content: '';
		position: absolute;
		inset: 0;
	}

	tbody :global(.row-link:focus-visible) {
		outline: none;
	}

	tbody tr:has(:global(.row-link:focus-visible)) {
		box-shadow: inset var(--focus-ring);
	}

	/* Anything else to press in a row sits above the stretched link. */
	tbody :global(:is(a, button, input, select, textarea, label, summary, form):not(.row-link)) {
		position: relative;
		z-index: 1;
	}
</style>
