<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { KIND_LABELS, STATE_LABELS, type MailboxState } from '#lib/domain/mailboxes.ts';
	import { formatBytes, formatCount, formatRelative } from '#lib/utils/format.ts';
	import { stateTone } from '#lib/utils/mailbox-tone.ts';
	import { toastFormResult } from '#lib/utils/form-toast.ts';

	let { data, form }: PageProps = $props();

	$effect(() => {
		toastFormResult(form);
	});

	const picked = $derived(new Set(data.picked));

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
					<tr
						><th>Mailbox</th><th>Kind</th><th>State</th><th>Messages</th><th>Size</th><th
							>Last sync</th
						>{#if data.picking}<th>Backed up</th>{/if}</tr
					>
				</thead>
				<tbody>
					{#each shown as mailbox (mailbox.id)}
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
	{/if}
</Card>

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

	.scroll {
		overflow-x: auto;
	}
</style>
