<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import SpeedCard from './speed-card.svelte';
	import { failureSummary } from '#lib/domain/failure-kind.ts';
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

	// The frame refreshes the live status on a timer; this page's load depends on it too.
	const engine = $derived(data.live.engine);

	const failingTotal = $derived(
		Object.values(engine.failing).reduce((sum, count) => sum + count, 0)
	);
	const failingText = $derived(failureSummary(engine.failing));

	$effect(() => {
		toastFormResult(form);
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
	{#if engine.pause.paused}
		<p><Badge tone="warn">Paused</Badge> Nothing syncs until you press Resume.</p>
	{/if}
	{#if engine.syncing.length > 0}
		<table>
			<thead>
				<tr><th>Mailbox</th><th>Folder</th><th>Stored this run</th><th>Started</th></tr>
			</thead>
			<tbody>
				{#each engine.syncing as live (live.mailboxId)}
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
	{:else if !engine.pause.paused}
		<p>No mailbox is syncing right now.</p>
	{/if}
	<dl class="facts">
		<dt>Download rate</dt>
		<dd>
			{formatBytes(engine.rates.lastMinute.bytesPerSecond)}/s,
			{engine.rates.lastMinute.messagesPerSecond.toFixed(1)} messages/s over the last minute
			<span class="muted small"
				>({formatBytes(engine.rates.last15Minutes.bytesPerSecond)}/s over 15 minutes)</span
			>
		</dd>
		<dt>Syncing</dt>
		<dd>
			{plural(engine.syncing.length, 'mailbox', 'mailboxes')} now. Lookstow runs up to {engine.slots
				.current} at a time (at most {engine.slots.maximum}).
		</dd>
		{#if failingText !== ''}
			<dt>Failing</dt>
			<dd>
				<Badge tone="warn">{plural(failingTotal, 'mailbox', 'mailboxes')}</Badge>
				{failingText}. Each is tried again after 30 seconds, then less often, up to every 15
				minutes.
			</dd>
		{/if}
		<dt>Microsoft throttling</dt>
		<dd>
			{#if engine.throttled.lastMinute > 0}
				<Badge tone="warn">{engine.throttled.lastMinute} in the last minute</Badge> Lookstow slows down
				by itself.
			{:else}
				None in the last minute{engine.throttled.last15Minutes > 0
					? ` (${engine.throttled.last15Minutes} in 15 minutes)`
					: ''}
			{/if}
		</dd>
		<dt>Waiting</dt>
		<dd>
			{#if engine.waiting.requested + engine.waiting.due + engine.waiting.firstCopy === 0}
				Nothing is waiting for a free slot.
			{:else}
				{plural(engine.waiting.requested, 'mailbox', 'mailboxes')} asked for,
				{plural(engine.waiting.firstCopy, 'first copy', 'first copies')} and
				{plural(engine.waiting.due, 'routine sync')} waiting for a free slot.
			{/if}
			{#if engine.waiting.later > 0}
				{plural(engine.waiting.later, 'mailbox', 'mailboxes')} up to date{engine.waiting
					.nextDueAt === null
					? ''
					: `; the next sync is due ${formatRelative(engine.waiting.nextDueAt)}`}.
			{/if}
		</dd>
		<dt>Discovery</dt>
		<dd>
			{#if engine.discovery.running}
				{@const progress = engine.discovery.progress}
				{#if progress !== null && progress.usersTotal !== null}
					Checked {formatCount(progress.usersChecked)} of {formatCount(progress.usersTotal)} users, found
					{plural(progress.found, 'mailbox', 'mailboxes')}
				{:else}
					Listing users
				{/if}
			{:else}
				Last {formatDateTime(engine.discovery.lastAt)}{data.lastDiscovery !== null &&
				data.lastDiscovery.outcome === 'failed'
					? ' (failed)'
					: ''}{engine.discovery.nextAt === null
					? ''
					: `, next ${formatRelative(engine.discovery.nextAt)}`}
			{/if}
		</dd>
		{#if engine.relayout !== null}
			<dt>Moving files</dt>
			<dd>
				<Badge tone="info">Running</Badge>
				Moving files stored before 0.4.0 into the date layout: {formatCount(engine.relayout.moved)} of
				{formatCount(engine.relayout.total)}. Syncs start when it is done.
			</dd>
		{/if}
		<dt>Index copy</dt>
		<dd>
			{#if engine.indexSnapshot.running}
				<Badge tone="info">Copying</Badge>
			{:else if engine.indexSnapshot.lastAt === null}
				<Badge tone="warn">None yet</Badge>
			{:else}
				Last {formatDateTime(engine.indexSnapshot.lastAt)}
			{/if}
		</dd>
		<dt>Completeness</dt>
		<dd>
			{#if data.totals.completenessNeedsLook === 0 && data.totals.completenessChecking === 0}
				Every checked folder matches Microsoft's count, or the difference is explained
			{:else}
				{#if data.totals.completenessNeedsLook > 0}
					<Badge tone="warn">Needs a look</Badge>
					<a href={resolve('/mailboxes/show/[state]', { state: 'needs-look' })}
						>{plural(data.totals.completenessNeedsLook, 'mailbox', 'mailboxes')}</a
					>
					still {data.totals.completenessNeedsLook === 1 ? 'differs' : 'differ'} from Microsoft a day
					after Lookstow read the folder again.
				{/if}
				{#if data.totals.completenessChecking > 0}
					<a href={resolve('/mailboxes/show/[state]', { state: 'checking' })}
						>{plural(data.totals.completenessChecking, 'mailbox', 'mailboxes')}</a
					>
					being checked: Lookstow is reading the folder again. Nothing to do.
				{/if}
			{/if}
		</dd>
		<dt>Backup drive</dt>
		<dd>
			{#if engine.disk.usedPercent === null}
				Unknown
			{:else}
				<Badge
					tone={engine.disk.level === 'full' ? 'bad' : engine.disk.level === 'warn' ? 'warn' : 'ok'}
					>{formatPercent(engine.disk.usedPercent)} used</Badge
				>
				{formatBytes(engine.disk.freeBytes ?? 0)} free · pauses at {engine.disk.pausePercent}%
			{/if}
		</dd>
	</dl>
</Card>

<SpeedCard speed={data.live.speed} />

{#if data.needsAttention.length > 0}
	<Card title="Needs attention" tone="bad">
		<table>
			<thead><tr><th>Mailbox</th><th>Problem</th><th>Last tried</th></tr></thead>
			<tbody>
				{#each data.needsAttention as mailbox (mailbox.id)}
					<tr>
						<td>
							<a href={resolve('/mailboxes/[id]', { id: mailbox.id })}>{mailbox.address}</a>
							{#if mailbox.kind === 'archive'}<span class="muted small">(online archive)</span>{/if}
						</td>
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
