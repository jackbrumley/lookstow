<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Card from '#lib/ui/card.svelte';
	import DataTable from '#lib/ui/data-table.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatDateTime, plural } from '#lib/utils/format.ts';

	let { data }: PageProps = $props();

	type RowEntry = PageProps['data']['entries'][number];
	type RowRun = PageProps['data']['discoveries'][number];

	const filters = [
		{ value: 'all', label: 'Everything' },
		{ value: 'error', label: 'Problems' },
		{ value: 'warn', label: 'Warnings' }
	];
</script>

<PageHeader title="Activity" lede="What Lookstow did and found, newest first. Kept for 90 days." />

<form class="filters" method="GET" aria-label="Show">
	{#each filters as filter (filter.value)}
		<button
			type="submit"
			name={filter.value === 'all' ? undefined : 'level'}
			value={filter.value === 'all' ? undefined : filter.value}
			class:current={data.level === filter.value}>{filter.label}</button
		>
	{/each}
</form>

<Card>
	<DataTable
		columns={['When', 'What', 'Who']}
		rows={data.entries}
		key={(entry: RowEntry) => entry.id}
		empty="Nothing yet."
	>
		{#snippet cells(entry: RowEntry)}
			<td class="when">{formatDateTime(entry.at)}</td>
			<td>
				{#if entry.level !== 'info'}
					<Badge tone={entry.level === 'error' ? 'bad' : 'warn'}
						>{entry.level === 'error' ? 'Problem' : 'Warning'}</Badge
					>
				{/if}
				{#if entry.mailboxId !== null}
					<a class="row-link" href={resolve('/mailboxes/[id]', { id: entry.mailboxId })}
						>{entry.summary}</a
					>
				{:else}
					{entry.summary}
				{/if}
				{#if entry.detail !== null}<div class="muted small detail">{entry.detail}</div>{/if}
			</td>
			<td>{entry.actor}</td>
		{/snippet}
	</DataTable>
</Card>

{#if data.entries.length > 0}
	<form class="older" method="GET">
		{#if data.level !== 'all'}<input type="hidden" name="level" value={data.level} />{/if}
		<input type="hidden" name="before" value={data.entries.at(-1)?.at ?? ''} />
		{#if data.paged}<a href={resolve('/activity')}>Newest</a>{/if}
		<button type="submit">Older entries</button>
	</form>
{/if}

<Card title="Discovery runs">
	<DataTable
		columns={['Started', 'Result', 'New', 'Gone']}
		rows={data.discoveries}
		key={(run: RowRun) => run.id}
		empty="Discovery has not run yet."
	>
		{#snippet cells(run: RowRun)}
			<td>{formatDateTime(run.startedAt)}</td>
			<td>
				<Badge tone={run.outcome === 'ok' ? 'ok' : run.outcome === 'running' ? 'info' : 'bad'}
					>{run.outcome}</Badge
				>
				{#if run.error !== null}<div class="small muted">{run.error}</div>{/if}
			</td>
			<td>{plural(run.added, 'mailbox', 'mailboxes')}</td>
			<td>{plural(run.removed, 'mailbox', 'mailboxes')}</td>
		{/snippet}
	</DataTable>
</Card>

<style>
	.filters {
		display: flex;
		gap: var(--space-2);
	}

	.filters button {
		font: inherit;
		color: var(--colour-text);
		background: var(--colour-surface);
		padding: var(--space-1) var(--space-3);
		border-radius: 999px;
		border: 1px solid var(--colour-border);
		cursor: pointer;
	}

	.filters button.current {
		background: var(--colour-brand);
		border-color: var(--colour-brand);
		color: var(--colour-text-inverse);
	}

	.older {
		display: flex;
		gap: var(--space-4);
		justify-content: center;
		align-items: center;
	}

	.older button {
		font: inherit;
		color: var(--colour-text);
		background: var(--colour-surface);
		border: 1px solid var(--colour-border);
		border-radius: 999px;
		padding: var(--space-1) var(--space-4);
		cursor: pointer;
	}

	.when {
		white-space: nowrap;
	}

	.detail {
		overflow-wrap: anywhere;
	}
</style>
