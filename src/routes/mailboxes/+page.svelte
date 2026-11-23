<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page as currentPage } from '$app/state';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import FormModal from '#lib/ui/form-modal.svelte';
	import ExistingBackupChoice from '#lib/ui/existing-backup-choice.svelte';
	import Card from '#lib/ui/card.svelte';
	import DataTable from '#lib/ui/data-table.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import {
		COMPLETENESS_LABELS,
		KIND_LABELS,
		STATE_LABELS,
		type MailboxState,
		type MailboxSummary
	} from '#lib/domain/mailboxes.ts';
	import { mailboxListQuery, sortsDescending, type SortKey } from '#lib/domain/mailbox-list.ts';
	import { formatBytes, formatCount, formatRelative, plural } from '#lib/utils/format.ts';
	import { stateTone } from '#lib/utils/mailbox-tone.ts';
	import { toastFormResult } from '#lib/utils/form-toast.ts';

	let { data, form }: PageProps = $props();

	type RowMailbox = PageProps['data']['list']['rows'][number];

	$effect(() => {
		toastFormResult(form);
	});

	const picked = $derived(new Set(data.picked));

	/** The mailbox whose Unpick dialog is open (only for mailboxes that have a backup). */
	let unpicking = $state<MailboxSummary | null>(null);
	let unpickOpen = $derived(unpicking !== null);

	// The server filters, sorts and pages (docs/specs/SPEC-SCALE.md). The filters are a GET form, so
	// every choice is in the address: a change sends it at once, typing after a short pause.
	const query = $derived(mailboxListQuery(currentPage.url.searchParams));
	const list = $derived(data.list);
	let filters = $state<HTMLFormElement | null>(null);
	let typing: ReturnType<typeof setTimeout> | undefined;

	function send(): void {
		clearTimeout(typing);
		filters?.requestSubmit();
	}

	function find(): void {
		clearTimeout(typing);
		typing = setTimeout(send, 250);
	}

	/** The order a column's button asks for: the other way round when it is the current one. */
	function orderFor(key: SortKey): string {
		const descending = query.sort === key ? !query.descending : sortsDescending(key);
		return `${key}:${descending ? 'desc' : 'asc'}`;
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
	<p class="muted small">
		Backing up the {plural(data.pickedCount, 'mailbox', 'mailboxes')} you picked. To pick more, choose
		Every mailbox and use <strong>Pick</strong>; to back up every mailbox, change
		<a href={resolve('/settings')}>Settings</a> &gt; What is backed up.
	</p>
{/if}

<Card>
	<form
		method="GET"
		id="mailbox-filters"
		class="filters"
		bind:this={filters}
		data-sveltekit-replacestate
		data-sveltekit-keepfocus
		data-sveltekit-noscroll
	>
		<input
			type="search"
			name="q"
			placeholder="Find a mailbox"
			aria-label="Find a mailbox"
			value={query.search}
			oninput={find}
		/>
		<select name="state" aria-label="State" value={query.state} onchange={send}>
			<option value="in-backup">In the backup</option>
			<option value="all">Every mailbox</option>
			{#each states as state (state)}
				<option value={state}>{STATE_LABELS[state]}</option>
			{/each}
			<option value="checking"
				>{COMPLETENESS_LABELS.checking} ({formatCount(list.incomplete.checking)})</option
			>
			<option value="needs-look"
				>{COMPLETENESS_LABELS['needs-look']} ({formatCount(list.incomplete['needs-look'])})</option
			>
		</select>
		<select name="kind" aria-label="Kind" value={query.kind} onchange={send}>
			<option value="all">Every kind</option>
			{#each list.kinds as kind (kind)}
				<option value={kind}>{KIND_LABELS[kind] ?? kind}</option>
			{/each}
		</select>
		<input
			type="hidden"
			name="order"
			value={`${query.sort}:${query.descending ? 'desc' : 'asc'}`}
		/>
		<span class="muted small">{formatCount(list.matching)} of {formatCount(list.total)}</span>
	</form>
	{#if list.total === 0}
		<p>
			No mailboxes yet. Discovery finds them once Microsoft 365 is connected on the Settings page.
		</p>
	{:else}
		<DataTable
			rows={list.rows}
			key={(mailbox: RowMailbox) => mailbox.id}
			label={(mailbox: RowMailbox) => mailbox.address}
			href={(mailbox: RowMailbox) => resolve('/mailboxes/[id]', { id: mailbox.id })}
			empty="No mailboxes match."
		>
			{#snippet head()}
				{#each columns as column (column.key)}
					<th
						aria-sort={query.sort === column.key
							? query.descending
								? 'descending'
								: 'ascending'
							: 'none'}
					>
						<button
							type="submit"
							form="mailbox-filters"
							name="order"
							value={orderFor(column.key)}
							class="sort"
							>{column.label}{query.sort === column.key
								? query.descending
									? ' ↓'
									: ' ↑'
								: ''}</button
						>
					</th>
				{/each}
				{#if data.picking}<th>Backed up</th>{/if}
			{/snippet}
			{#snippet first(mailbox: RowMailbox)}
				<div class="muted small">{mailbox.displayName}</div>
			{/snippet}
			{#snippet cells(mailbox: RowMailbox)}
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
			{/snippet}
		</DataTable>
		{#if list.pageCount > 1}
			<nav class="pages" aria-label="Pages">
				<button
					type="submit"
					form="mailbox-filters"
					name="page"
					value={String(list.page - 1)}
					disabled={list.page === 0}>Previous</button
				>
				<span>Page {list.page + 1} of {list.pageCount}</span>
				<button
					type="submit"
					form="mailbox-filters"
					name="page"
					value={String(list.page + 1)}
					disabled={list.page >= list.pageCount - 1}>Next</button
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
</style>
