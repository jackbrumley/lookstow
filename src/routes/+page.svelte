<script lang="ts">
	import { enhance } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { toastFormResult } from '#lib/utils/form-toast.ts';
	import {
		formatBytes,
		formatCount,
		formatDateTime,
		formatPercent,
		formatRelative,
		plural
	} from '#lib/utils/format.ts';

	let { data, form }: PageProps = $props();

	$effect(() => {
		toastFormResult(form);
	});

	// The dashboard follows the engine: every few seconds while it works, every 30 s otherwise.
	onMount(() => {
		let timer: ReturnType<typeof setTimeout>;
		const refresh = () => {
			timer = setTimeout(
				() => {
					void refreshAll().finally(refresh);
				},
				data.engine.syncing.length === 0 && !data.engine.discovery.running ? 30_000 : 4_000
			);
		};
		refresh();
		return () => {
			clearTimeout(timer);
		};
	});

	const setupDone = $derived(data.setup.ids && data.setup.credential && data.setup.discovered);
</script>

<PageHeader title="Dashboard" lede="Whether every mailbox is backed up, and what is running now.">
	{#snippet actions()}
		<form method="POST" action="?/discover" use:enhance>
			<Button type="submit" variant="secondary">Discover now</Button>
		</form>
		<form method="POST" action="?/syncAll" use:enhance>
			<Button type="submit">Sync all now</Button>
		</form>
	{/snippet}
</PageHeader>

{#if !setupDone}
	<Card title="Set up Lookstow" tone="warn">
		<ol class="steps">
			<li class:done={data.setup.ids}>
				Register an app in Microsoft Entra and enter its tenant and application IDs.
			</li>
			<li class:done={data.setup.credential}>
				Create Lookstow's certificate and upload it to the app registration.
			</li>
			<li class:done={data.setup.discovered}>Run discovery to find every mailbox.</li>
		</ol>
		<p><a href={resolve('/settings')}>Open Settings</a> for the steps, with the exact commands.</p>
	</Card>
{/if}

<div class="tiles">
	<div class="tile">
		<span class="label">Backed up</span>
		<strong>{formatCount(data.totals.backedUp)}</strong>
		<span class="muted small">of {plural(data.totals.mailboxes, 'mailbox', 'mailboxes')}</span>
	</div>
	<div class="tile">
		<span class="label">Waiting for first copy</span>
		<strong>{formatCount(data.totals.waiting + data.totals.syncing)}</strong>
	</div>
	<div class="tile" class:bad={data.totals.failed > 0}>
		<span class="label">Failing</span>
		<strong>{formatCount(data.totals.failed)}</strong>
	</div>
	<div class="tile">
		<span class="label">Stored</span>
		<strong>{formatBytes(data.totals.bytes)}</strong>
		<span class="muted small">{plural(data.totals.items, 'message')}</span>
	</div>
</div>

<Card title="Now">
	{#if data.engine.pause.paused}
		<p><Badge tone="warn">Paused</Badge> Nothing syncs until you press Resume.</p>
	{/if}
	{#if data.engine.syncing.length > 0}
		<table>
			<thead>
				<tr><th>Mailbox</th><th>Folder</th><th>Stored this run</th><th>Started</th></tr>
			</thead>
			<tbody>
				{#each data.engine.syncing as live (live.mailboxId)}
					<tr>
						<td>
							<a href={resolve('/mailboxes/[id]', { id: live.mailboxId })}>{live.address}</a>
							{#if live.firstCopy}<Badge tone="info">First copy</Badge>{/if}
						</td>
						<td>{live.folder === '' ? 'Listing folders' : live.folder}</td>
						<td>{plural(live.stored, 'message')}, {formatBytes(live.bytes)}</td>
						<td>{formatRelative(live.startedAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else if !data.engine.pause.paused}
		<p>No mailbox is syncing right now.</p>
	{/if}
	<dl class="facts">
		<dt>Syncing</dt>
		<dd>{data.engine.syncing.length} of {data.engine.slots} at a time</dd>
		<dt>Waiting</dt>
		<dd>
			{plural(data.engine.waiting.requested, 'asked for')},
			{plural(data.engine.waiting.due, 'routine sync')},
			{plural(data.engine.waiting.firstCopy, 'first copy', 'first copies')}
		</dd>
		<dt>Discovery</dt>
		<dd>
			{#if data.engine.discovery.running}
				Running now
			{:else}
				Last {formatDateTime(data.engine.discovery.lastAt)}{data.lastDiscovery !== null &&
				data.lastDiscovery.outcome === 'failed'
					? ' (failed)'
					: ''}{data.engine.discovery.nextAt === null
					? ''
					: `, next ${formatRelative(data.engine.discovery.nextAt)}`}
			{/if}
		</dd>
		<dt>Backup drive</dt>
		<dd>
			{#if data.engine.disk.usedPercent === null}
				Unknown
			{:else}
				<Badge
					tone={data.engine.disk.level === 'full'
						? 'bad'
						: data.engine.disk.level === 'warn'
							? 'warn'
							: 'ok'}>{formatPercent(data.engine.disk.usedPercent)} used</Badge
				>
				{formatBytes(data.engine.disk.freeBytes ?? 0)} free · pauses at {data.engine.disk
					.pausePercent}%
			{/if}
		</dd>
	</dl>
</Card>

{#if data.needsAttention.length > 0}
	<Card title="Needs attention" tone="bad">
		<table>
			<thead><tr><th>Mailbox</th><th>Problem</th><th>Last tried</th></tr></thead>
			<tbody>
				{#each data.needsAttention as mailbox (mailbox.id)}
					<tr>
						<td><a href={resolve('/mailboxes/[id]', { id: mailbox.id })}>{mailbox.address}</a></td>
						<td>{mailbox.lastSyncError}</td>
						<td>{formatRelative(mailbox.lastSyncFinishedAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</Card>
{/if}

{#if data.problems.length > 0}
	<Card title="Recent problems">
		<ul class="problems">
			{#each data.problems as entry (entry.id)}
				<li>
					<span class="muted small">{formatDateTime(entry.at)}</span>
					{entry.summary}{entry.detail === null ? '' : `: ${entry.detail}`}
				</li>
			{/each}
		</ul>
		<p><a href={resolve('/activity')}>All activity</a></p>
	</Card>
{/if}

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: var(--space-4);
	}

	.tile {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-4);
		background: var(--colour-surface);
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-lg);
	}

	.tile strong {
		font-size: var(--font-size-2xl);
	}

	.tile.bad strong {
		color: var(--colour-bad);
	}

	.label {
		font-size: var(--font-size-sm);
		color: var(--colour-text-muted);
	}

	.steps {
		margin: 0 0 var(--space-3);
		padding-left: var(--space-6);
		display: grid;
		gap: var(--space-2);
	}

	.steps li.done {
		color: var(--colour-text-muted);
		text-decoration: line-through;
	}

	.facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-4);
		margin: var(--space-4) 0 0;
	}

	.facts dt {
		color: var(--colour-text-muted);
	}

	.facts dd {
		margin: 0;
	}

	.problems {
		list-style: none;
		margin: 0 0 var(--space-3);
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}

	form {
		display: contents;
	}
</style>
