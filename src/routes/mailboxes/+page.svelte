<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import FormModal from '#lib/ui/form-modal.svelte';
	import ExistingBackupChoice from '#lib/ui/existing-backup-choice.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import {
		KIND_LABELS,
		STATE_LABELS,
		type MailboxState,
		type MailboxSummary
	} from '#lib/domain/mailboxes.ts';
	import { formatBytes, formatCount, formatRelative } from '#lib/utils/format.ts';
	import { stateTone } from '#lib/utils/mailbox-tone.ts';
	import { toastFormResult } from '#lib/utils/form-toast.ts';

	let { data, form }: PageProps = $props();

	$effect(() => {
		toastFormResult(form);
	});

	const picked = $derived(new Set(data.picked));

	/** The mailbox whose Unpick dialog is open (only for mailboxes that have a backup). */
	let unpicking = $state<MailboxSummary | null>(null);
	let unpickOpen = $derived(unpicking !== null);

	let search = $state('');
	let stateFilter = $state<MailboxState | 'all'>('all');
	let kindFilter = $state('all');

	const kinds = $derived([...new Set(data.mailboxes.map((mailbox) => mailbox.kind))].sort());
	const shown = $derived(
		data.mailboxes.filter((mailbox) => {
			const text = search.trim().toLowerCase();
			return (
				(stateFilter === 'all' || mailbox.state === stateFilter) &&
				(kindFilter === 'all' || mailbox.kind === kindFilter) &&
				(text === '' ||
					mailbox.address.includes(text) ||
					mailbox.displayName.toLowerCase().includes(text))
			);
		})
	);
	type SortKey = 'address' | 'kind' | 'state' | 'itemCount' | 'byteCount' | 'lastSync';
	const PAGE_SIZE = 100;
	let sortKey = $state<SortKey>('address');
	let descending = $state<boolean>(false);
	let pageIndex = $state(0);

	function sortValue(mailbox: MailboxSummary, key: SortKey): string | number {
		switch (key) {
			case 'address':
				return mailbox.address;
			case 'kind':
				return mailbox.kind;
			case 'state':
				return STATE_LABELS[mailbox.state];
			case 'itemCount':
				return mailbox.itemCount;
			case 'byteCount':
				return mailbox.byteCount;
			case 'lastSync':
				return mailbox.lastSyncFinishedAt ?? '';
		}
	}

	const sorted = $derived(
		[...shown].sort((a, b) => {
			const left = sortValue(a, sortKey);
			const right = sortValue(b, sortKey);
			const order =
				typeof left === 'number' && typeof right === 'number'
					? left - right
					: String(left).localeCompare(String(right));
			return descending ? -order : order;
		})
	);
	const pageCount = $derived(Math.max(1, Math.ceil(sorted.length / PAGE_SIZE)));
	// A narrower filter can leave fewer pages than the one open: show the last there is.
	const page = $derived(Math.min(pageIndex, pageCount - 1));
	const pageRows = $derived(sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));

	function sortBy(key: SortKey): void {
		pageIndex = 0;
		if (sortKey === key) {
			descending = !descending;
		} else {
			sortKey = key;
			// Numbers and dates read best largest and newest first.
			descending = key === 'itemCount' || key === 'byteCount' || key === 'lastSync';
		}
	}

	const columns: { key: SortKey; label: string }[] = [
		{ key: 'address', label: 'Mailbox' },
		{ key: 'kind', label: 'Kind' },
		{ key: 'state', label: 'State' },
		{ key: 'itemCount', label: 'Messages' },
		{ key: 'byteCount', label: 'Size' },
		{ key: 'lastSync', label: 'Last sync' }
	];

	const states = Object.keys(STATE_LABELS).filter(
		(key): key is MailboxState => key in STATE_LABELS
	);
</script>

<PageHeader
	title="Mailboxes"
	lede="Every mailbox Lookstow has found in Microsoft 365. Mailboxes that disappear keep their backup."
/>

{#if data.picking}
	<Card tone="warn">
		<p>
			Only the mailboxes you pick are backed up ({formatCount(picked.size)} picked). Use
			<strong>Pick</strong> on a row to back that mailbox up. To back up every mailbox again, change
			<a href={resolve('/settings')}>Settings</a> &gt; What is backed up.
		</p>
	</Card>
{/if}

<Card>
	<div class="filters">
		<input
			type="search"
			placeholder="Find a mailbox"
			aria-label="Find a mailbox"
			bind:value={search}
		/>
		<select aria-label="State" bind:value={stateFilter}>
			<option value="all">Every state</option>
			{#each states as state (state)}
				<option value={state}>{STATE_LABELS[state]}</option>
			{/each}
		</select>
		<select aria-label="Kind" bind:value={kindFilter}>
			<option value="all">Every kind</option>
			{#each kinds as kind (kind)}
				<option value={kind}>{KIND_LABELS[kind] ?? kind}</option>
			{/each}
		</select>
		<span class="muted small"
			>{formatCount(shown.length)} of {formatCount(data.mailboxes.length)}</span
		>
	</div>
	{#if data.mailboxes.length === 0}
		<p>
			No mailboxes yet. Discovery finds them once Microsoft 365 is connected on the Settings page.
		</p>
	{:else}
		<div class="scroll">
			<table>
				<thead>
					<tr>
						{#each columns as column (column.key)}
							<th
								aria-sort={sortKey === column.key
									? descending
										? 'descending'
										: 'ascending'
									: 'none'}
							>
								<button
									type="button"
									class="sort"
									onclick={() => {
										sortBy(column.key);
									}}
									>{column.label}{sortKey === column.key ? (descending ? ' ↓' : ' ↑') : ''}</button
								>
							</th>
						{/each}
						{#if data.picking}<th>Backed up</th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each pageRows as mailbox (mailbox.id)}
						<tr>
							<td>
								<a href={resolve('/mailboxes/[id]', { id: mailbox.id })}>{mailbox.address}</a>
								<div class="muted small">{mailbox.displayName}</div>
							</td>
							<td>{KIND_LABELS[mailbox.kind] ?? mailbox.kind}</td>
							<td><Badge tone={stateTone(mailbox.state)}>{STATE_LABELS[mailbox.state]}</Badge></td>
							<td>{formatCount(mailbox.itemCount)}</td>
							<td>{formatBytes(mailbox.byteCount)}</td>
							<td>{formatRelative(mailbox.lastSyncFinishedAt)}</td>
							{#if data.picking}
								<td>
									{#if mailbox.kind === 'archive'}
										<span class="muted small">With its mailbox</span>
									{:else if picked.has(mailbox.address) && mailbox.itemCount > 0}
										<Button size="sm" variant="secondary" onclick={() => (unpicking = mailbox)}
											>Unpick…</Button
										>
									{:else}
										<form
											method="POST"
											action={picked.has(mailbox.address) ? '?/unpick' : '?/pick'}
											use:enhance
										>
											<input type="hidden" name="address" value={mailbox.address} />
											<Button
												type="submit"
												size="sm"
												variant={picked.has(mailbox.address) ? 'secondary' : 'primary'}
												>{picked.has(mailbox.address) ? 'Unpick' : 'Pick'}</Button
											>
										</form>
									{/if}
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if pageCount > 1}
			<nav class="pages" aria-label="Pages">
				<button type="button" disabled={page === 0} onclick={() => (pageIndex = page - 1)}
					>Previous</button
				>
				<span>Page {page + 1} of {pageCount}</span>
				<button
					type="button"
					disabled={page >= pageCount - 1}
					onclick={() => (pageIndex = page + 1)}>Next</button
				>
			</nav>
		{/if}
	{/if}
</Card>

{#if unpicking !== null}
	<FormModal
		bind:open={unpickOpen}
		title={`Stop backing up ${unpicking.address}?`}
		action="?/unpick"
		submitLabel="Unpick"
		onsuccess={() => (unpicking = null)}
	>
		<input type="hidden" name="address" value={unpicking.address} />
		<ExistingBackupChoice
			address={unpicking.address}
			itemCount={unpicking.itemCount}
			byteCount={unpicking.byteCount}
		/>
	</FormModal>
{/if}

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		align-items: center;
		margin-bottom: var(--space-4);
	}

	.filters input {
		flex: 1 1 16rem;
	}

	.sort {
		font: inherit;
		color: inherit;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-transform: inherit;
		letter-spacing: inherit;
	}

	.pages {
		display: flex;
		gap: var(--space-3);
		align-items: center;
		justify-content: center;
		margin-top: var(--space-4);
	}

	.pages button {
		font: inherit;
		color: var(--colour-text);
		background: var(--colour-surface);
		border: 1px solid var(--colour-border);
		border-radius: 999px;
		padding: var(--space-1) var(--space-4);
		cursor: pointer;
	}

	.pages button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.scroll {
		overflow-x: auto;
	}
</style>
