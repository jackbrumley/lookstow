<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import DetailView from '#lib/ui/detail-view.svelte';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import DataTable from '#lib/ui/data-table.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import SpeedCard from './speed-card.svelte';
	import { toastFormResult } from '#lib/utils/form-toast.ts';
	import { invalidate } from '$app/navigation';
	import { LIVE_STATUS } from '#lib/domain/live-status.ts';
	import { pending, type PendingKind } from '#lib/runes/pending.svelte.ts';
	import {
		formatBytes,
		formatCount,
		formatDateTime,
		formatPercent,
		formatRelative,
		plural
	} from '#lib/utils/format.ts';

	let { data, form }: PageProps = $props();

	type RowItem = PageProps['data']['overview']['attention'][number];
	type RowLive = PageProps['data']['live']['engine']['syncing'][number];
	type RowCopy = PageProps['data']['overview']['firstCopies'][number];
	type RowEntry = PageProps['data']['problems']['open'][number];

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

	// Buttons answer at once ("Starting…") and wait while their work runs; the live status, which
	// the frame refreshes, says when it is under way or done (runes/pending.svelte.ts).
	const syncAllBusy = $derived(pending.current?.kind === 'sync-all' || engine.syncAll);
	const discoverBusy = $derived(pending.current?.kind === 'discover' || engine.discovery.running);

	/** A form that shows `text` at once, and refreshes the live status soon after the answer. */
	function starting(kind: PendingKind, text: string): SubmitFunction {
		return () => {
			pending.start(kind, text);
			return async ({ result, update }) => {
				if (result.type !== 'success') pending.clear();
				await update();
				// The engine starts within a second; ask again then instead of at the next timer.
				setTimeout(() => {
					void invalidate(LIVE_STATUS);
				}, 1200);
			};
		};
	}
</script>

{#snippet problemList(entries: typeof data.problems.open)}
	<div class="problems">
		<DataTable
			columns={['When', 'What']}
			rows={entries}
			key={(entry: RowEntry) => entry.id}
			compact
		>
			{#snippet cells(entry: RowEntry)}
				<td class="nowrap">{formatDateTime(entry.at)}</td>
				<td>{entry.summary}{entry.detail === null ? '' : `: ${entry.detail}`}</td>
			{/snippet}
		</DataTable>
	</div>
{/snippet}

<PageHeader title="Dashboard" lede="Whether every mailbox is backed up, and what is happening now.">
	{#snippet actions()}
		{#if data.remote === null}
			<form
				method="POST"
				action="?/discover"
				use:enhance={starting('discover', 'Starting discovery…')}
			>
				<Button type="submit" variant="secondary" disabled={discoverBusy}
					>{discoverBusy ? 'Discovering…' : 'Discover now'}</Button
				>
			</form>
			<form
				method="POST"
				action="?/syncAll"
				use:enhance={starting('sync-all', 'Starting a sync of every mailbox…')}
			>
				<Button
					type="submit"
					disabled={syncAllBusy || engine.pause.paused}
					title={engine.pause.paused ? 'Backups are paused: press Resume first' : undefined}
					>{syncAllBusy ? 'Syncing all…' : 'Sync all now'}</Button
				>
			</form>
		{/if}
	{/snippet}
</PageHeader>

{#if data.remoteAccess !== null}
	<a class="remote-note" href={resolve('/settings')}>
		<Badge tone="info">Remote access is on</Badge>
		<span class="muted small"
			>{plural(data.remoteAccess.accounts, 'account', 'accounts')} can sign in from {plural(
				data.remoteAccess.allowed,
				'allowed address or range',
				'allowed addresses or ranges'
			)}. Turn it off in Settings when it is no longer needed.</span
		>
	</a>
{/if}

{#if !setupDone && data.remote === null}
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
		<DataTable
			columns={['Mailbox', 'What is wrong', 'What happens next', '']}
			rows={overview.attention}
			key={(item: RowItem) => item.id}
			label={(item: RowItem) => item.address}
			href={(item: RowItem) => resolve('/mailboxes/[id]', { id: item.id })}
		>
			{#snippet first(item: RowItem)}
				{#if item.kind === 'archive'}<span class="muted small">(online archive)</span>{/if}
			{/snippet}
			{#snippet cells(item: RowItem)}
				<td>{item.problem}</td>
				<td>{item.what}</td>
				<td>
					{#if data.remote === null}
						<form
							method="POST"
							action="?/recheck"
							use:enhance={starting('check-again', `Checking ${item.address} again…`)}
						>
							<input type="hidden" name="mailboxId" value={item.id} />
							<Button
								type="submit"
								size="sm"
								variant="secondary"
								disabled={pending.current !== null}>Check again now</Button
							>
						</form>
					{/if}
				</td>
			{/snippet}
		</DataTable>
		{#if data.problems.open.length > 0}
			{@render problemList(data.problems.open)}
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
		<DataTable
			columns={['Mailbox', 'Folder', 'Stored this run', 'Started']}
			rows={engine.syncing}
			key={(live: RowLive) => live.mailboxId}
			label={(live: RowLive) => live.address}
			href={(live: RowLive) => resolve('/mailboxes/[id]', { id: live.mailboxId })}
		>
			{#snippet first(live: RowLive)}
				{#if archives.has(live.mailboxId)}<span class="muted small">(online archive)</span>{/if}
				{#if live.firstCopy}<Badge tone="info">First copy</Badge>{/if}
			{/snippet}
			{#snippet cells(live: RowLive)}
				<td>{live.folder === '' ? 'Listing folders' : live.folder}</td>
				<td>{plural(live.stored, 'message')}, {formatBytes(live.bytes)}</td>
				<td>{formatRelative(live.startedAt)}</td>
			{/snippet}
		</DataTable>
	{/if}
</Card>

{#if overview.firstCopies.length > 0}
	<Card title="First copies in progress">
		<p class="muted small">
			A mailbox's first copy reads every folder once. After that, each sync fetches only what
			changed. Items Microsoft will not send are listed on the mailbox's page and do not hold the
			first copy up.
		</p>
		<DataTable
			columns={['Mailbox', 'Folders copied', '']}
			rows={overview.firstCopies}
			key={(copy: RowCopy) => copy.id}
			label={(copy: RowCopy) => copy.address}
			href={(copy: RowCopy) => resolve('/mailboxes/[id]', { id: copy.id })}
		>
			{#snippet first(copy: RowCopy)}
				{#if copy.kind === 'archive'}<span class="muted small">(online archive)</span>{/if}
			{/snippet}
			{#snippet cells(copy: RowCopy)}
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
					{#if copy.syncing}<Badge tone="info">Copying now</Badge>{:else}<span class="muted small"
							>Waiting for its turn</span
						>{/if}
				</td>
			{/snippet}
		</DataTable>
	</Card>
{/if}

<details class="more">
	<summary>Details: discovery, index copy, completeness checks, backup drive and the queue</summary>
	<DetailView>
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
	</DetailView>
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
		{@render problemList(data.problems.cleared)}
		<p><a href={resolve('/activity')}>All activity</a></p>
	</details>
{/if}

<style>
	.remote-note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		color: inherit;
		text-decoration: none;
	}

	.remote-note:hover span {
		text-decoration: underline;
	}

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

	.problems {
		margin: var(--space-3) 0;
	}

	.nowrap {
		white-space: nowrap;
	}

	form {
		display: contents;
	}
</style>
