<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import SpeedCard from './speed-card.svelte';
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
	const overview = $derived(data.overview);
	const archives = $derived(new Set(data.archives));

	/** Folders copied across every first copy under way, for the tile. */
	const firstCopyFolders = $derived(
		overview.firstCopies.reduce(
			(sum, copy) => ({ done: sum.done + copy.foldersDone, total: sum.total + copy.foldersTotal }),
			{ done: 0, total: 0 }
		)
	);

	$effect(() => {
		toastFormResult(form);
	});

	const setupDone = $derived(data.setup.ids && data.setup.credential && data.setup.discovered);
</script>

<PageHeader title="Dashboard" lede="Whether every mailbox is backed up, and what is happening now.">
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

<!-- Lasting facts: they change when a mailbox is added, finishes its first copy or stops being
	backed up, not with every sync. -->
<div class="tiles">
	<a class="tile" href={resolve('/mailboxes')}>
		<span class="label">In the backup</span>
		<strong>{formatCount(overview.inBackup)}</strong>
		<span class="muted small"
			>{plural(overview.inBackup, 'mailbox', 'mailboxes')}, of {formatCount(overview.found)} found in
			Microsoft 365</span
		>
	</a>
	<div class="tile">
		<span class="label">Fully copied</span>
		<strong>{formatCount(overview.fullyCopied)} of {formatCount(overview.inBackup)}</strong>
		<span class="muted small">first copy finished; kept up to date from then on</span>
	</div>
	{#if overview.firstCopies.length > 0}
		<div class="tile">
			<span class="label">First copy in progress</span>
			<strong>{formatCount(overview.firstCopies.length)}</strong>
			<span class="muted small"
				>{formatCount(firstCopyFolders.done)} of {plural(firstCopyFolders.total, 'folder')} copied</span
			>
		</div>
	{/if}
	<div class="tile" class:bad={overview.attention.length > 0}>
		<span class="label">Needs attention</span>
		<strong>{formatCount(overview.attention.length)}</strong>
		<span class="muted small"
			>{overview.attention.length === 0 ? 'nothing to do' : 'see below'}</span
		>
	</div>
	<div class="tile">
		<span class="label">Stored</span>
		<strong>{formatBytes(overview.storedBytes)}</strong>
		<span class="muted small">{plural(overview.storedItems, 'message')}</span>
	</div>
</div>

{#if overview.attention.length > 0}
	<Card title="Needs attention" tone="bad">
		<table>
			<thead><tr><th>Mailbox</th><th>What is wrong</th><th>What happens next</th></tr></thead>
			<tbody>
				{#each overview.attention as item (item.id)}
					<tr>
						<td>
							<a href={resolve('/mailboxes/[id]', { id: item.id })}>{item.address}</a>
							{#if item.kind === 'archive'}<span class="muted small">(online archive)</span>{/if}
						</td>
						<td>{item.problem}</td>
						<td>{item.what}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if data.problems.open.length > 0}
			<ul class="problems">
				{#each data.problems.open as entry (entry.id)}
					<li>
						<span class="muted small">{formatDateTime(entry.at)}</span>
						{entry.summary}{entry.detail === null ? '' : `: ${entry.detail}`}
					</li>
				{/each}
			</ul>
		{/if}
	</Card>
{/if}

<Card title="Right now">
	<p>
		{#if engine.pause.paused}
			<Badge tone="warn">Paused</Badge> Nothing syncs until you press Resume.
		{:else if engine.syncing.length > 0}
			Syncing {plural(engine.syncing.length, 'mailbox', 'mailboxes')}, receiving
			{formatBytes(data.live.speed.rates.lastMinute.bytes / 60)}/s.
			{#if engine.waiting.nextDueAt !== null}
				The next routine sync is due {formatRelative(engine.waiting.nextDueAt)}.
			{/if}
		{:else}
			Nothing is syncing; every mailbox is up to date.
			{#if engine.waiting.nextDueAt !== null}
				The next sync is due {formatRelative(engine.waiting.nextDueAt)}.
			{/if}
		{/if}
		{#if overview.paused > 0}
			<span class="muted small"
				>{plural(overview.paused, 'mailbox is', 'mailboxes are')} paused by choice.</span
			>
		{/if}
	</p>
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
							{#if archives.has(live.mailboxId)}<span class="muted small">(online archive)</span
								>{/if}
							{#if live.firstCopy}<Badge tone="info">First copy</Badge>{/if}
						</td>
						<td>{live.folder === '' ? 'Listing folders' : live.folder}</td>
						<td>{plural(live.stored, 'message')}, {formatBytes(live.bytes)}</td>
						<td>{formatRelative(live.startedAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</Card>

{#if overview.firstCopies.length > 0}
	<Card title="First copies in progress">
		<p class="muted small">
			A mailbox's first copy reads every folder once. After that, each sync fetches only what
			changed. Items Microsoft will not send are listed on the mailbox's page and do not hold the
			first copy up.
		</p>
		<table>
			<thead><tr><th>Mailbox</th><th>Folders copied</th><th></th></tr></thead>
			<tbody>
				{#each overview.firstCopies as copy (copy.id)}
					<tr>
						<td>
							<a href={resolve('/mailboxes/[id]', { id: copy.id })}>{copy.address}</a>
							{#if copy.kind === 'archive'}<span class="muted small">(online archive)</span>{/if}
						</td>
						<td>
							{#if copy.foldersTotal === 0}
								Listing folders
							{:else}
								{formatCount(copy.foldersDone)} of {formatCount(copy.foldersTotal)}
								<span class="muted small"
									>({formatPercent((copy.foldersDone / copy.foldersTotal) * 100)})</span
								>
							{/if}
						</td>
						<td>
							{#if copy.syncing}<Badge tone="info">Copying now</Badge>{:else}<span
									class="muted small">Waiting for its turn</span
								>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</Card>
{/if}

<details class="more">
	<summary>Details: discovery, index copy, completeness checks, backup drive and the queue</summary>
	<dl class="facts">
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
				Last {formatDateTime(engine.indexSnapshot.lastAt)} (a daily copy of the index on the backup drive)
			{/if}
		</dd>
		<dt>Completeness</dt>
		<dd>
			{#if data.completeness.checking === 0}
				Every checked folder matches Microsoft's count, or the difference is explained
			{:else}
				<a href={resolve('/mailboxes/show/[state]', { state: 'checking' })}
					>{plural(data.completeness.checking, 'mailbox', 'mailboxes')}</a
				>
				being checked: Lookstow is reading a folder again to compare it with Microsoft. Nothing to do.
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
		<dt>Mailboxes at once</dt>
		<dd>
			Up to {engine.slots.current} now, at most {engine.slots.maximum}. Lookstow adds more while
			Microsoft is not holding it back.
		</dd>
		<dt>Queue</dt>
		<dd>
			{#if engine.waiting.requested + engine.waiting.due + engine.waiting.firstCopy === 0}
				No mailbox is waiting for a free slot.
			{:else}
				Waiting for a free slot: {plural(engine.waiting.requested, 'asked for', 'asked for')},
				{plural(engine.waiting.firstCopy, 'first copy', 'first copies')},
				{plural(engine.waiting.due, 'routine sync')}.
			{/if}
		</dd>
		<dt>Microsoft throttling</dt>
		<dd>
			{engine.throttled.lastMinute} in the last minute, {engine.throttled.last15Minutes} in 15 minutes.
			Lookstow slows down by itself when Microsoft asks it to.
		</dd>
	</dl>
</details>

<details class="more">
	<summary>Speed details, for looking into a slow backup</summary>
	<SpeedCard speed={data.live.speed} />
</details>

{#if data.problems.cleared.length > 0}
	<details class="more">
		<summary
			>Earlier problems ({data.problems.cleared.length}), since cleared or not about a mailbox</summary
		>
		<ul class="problems">
			{#each data.problems.cleared as entry (entry.id)}
				<li>
					<span class="muted small">{formatDateTime(entry.at)}</span>
					{entry.summary}{entry.detail === null ? '' : `: ${entry.detail}`}
				</li>
			{/each}
		</ul>
		<p><a href={resolve('/activity')}>All activity</a></p>
	</details>
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
		color: inherit;
		text-decoration: none;
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

	.more {
		background: var(--colour-surface);
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-lg);
		padding: var(--space-3) var(--space-4);
	}

	.more summary {
		cursor: pointer;
		font-weight: var(--font-weight-medium);
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
		margin: var(--space-3) 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}

	form {
		display: contents;
	}
</style>
