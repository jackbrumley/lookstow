<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatDateTime, plural } from '#lib/utils/format.ts';

	let { data }: PageProps = $props();

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
	{#if data.entries.length === 0}
		<p class="muted">Nothing yet.</p>
	{:else}
		<table>
			<thead><tr><th>When</th><th>What</th><th>Who</th></tr></thead>
			<tbody>
				{#each data.entries as entry (entry.id)}
					<tr>
						<td class="when">{formatDateTime(entry.at)}</td>
						<td>
							{#if entry.level !== 'info'}
								<Badge tone={entry.level === 'error' ? 'bad' : 'warn'}
									>{entry.level === 'error' ? 'Problem' : 'Warning'}</Badge
								>
							{/if}
							{#if entry.mailboxId !== null}
								<a href={resolve('/mailboxes/[id]', { id: entry.mailboxId })}>{entry.summary}</a>
							{:else}
								{entry.summary}
							{/if}
							{#if entry.detail !== null}<div class="muted small detail">{entry.detail}</div>{/if}
						</td>
						<td>{entry.actor}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</Card>

<Card title="Discovery runs">
	{#if data.discoveries.length === 0}
		<p class="muted">Discovery has not run yet.</p>
	{:else}
		<table>
			<thead><tr><th>Started</th><th>Result</th><th>New</th><th>Gone</th></tr></thead>
			<tbody>
				{#each data.discoveries as run (run.id)}
					<tr>
						<td>{formatDateTime(run.startedAt)}</td>
						<td>
							<Badge tone={run.outcome === 'ok' ? 'ok' : run.outcome === 'running' ? 'info' : 'bad'}
								>{run.outcome}</Badge
							>
							{#if run.error !== null}<div class="small muted">{run.error}</div>{/if}
						</td>
						<td>{plural(run.added, 'mailbox', 'mailboxes')}</td>
						<td>{plural(run.removed, 'mailbox', 'mailboxes')}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
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

	.when {
		white-space: nowrap;
	}

	.detail {
		overflow-wrap: anywhere;
	}
</style>
