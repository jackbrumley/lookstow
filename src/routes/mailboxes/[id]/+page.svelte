<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import DetailView from '#lib/ui/detail-view.svelte';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import DataTable from '#lib/ui/data-table.svelte';
	import FormModal from '#lib/ui/form-modal.svelte';
	import ConfirmForm from '#lib/ui/confirm-form.svelte';
	import ExistingBackupChoice from '#lib/ui/existing-backup-choice.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { KIND_LABELS, STATE_LABELS } from '#lib/domain/mailboxes.ts';
	import { toastFormResult } from '#lib/utils/form-toast.ts';
	import {
		formatBytes,
		formatCount,
		formatDateTime,
		formatRelative,
		plural
	} from '#lib/utils/format.ts';
	import { stateTone } from '#lib/utils/mailbox-tone.ts';

	let { data, form }: PageProps = $props();

	type RowFolder = PageProps['data']['mailbox']['folders'][number];
	type RowFailure = PageProps['data']['failures']['items'][number];
	type RowRun = PageProps['data']['mailbox']['recentRuns'][number];
	type RowEntry = PageProps['data']['activity'][number];

	$effect(() => {
		toastFormResult(form);
	});

	let excludeOpen = $state(false);
	const mailbox = $derived(data.mailbox);

	type Folder = (typeof data.mailbox.folders)[number];

	/** An explained difference, in a few words beside Microsoft's count. */
	function explainedText(gap: Extract<Folder['gap'], { kind: 'explained' }>): string {
		const parts = [
			gap.waiting > 0 ? `${formatCount(gap.waiting)} waiting to be copied again` : '',
			gap.givenUp > 0 ? `${formatCount(gap.givenUp)} failed 5 tries` : '',
			gap.otherItems > 0 ? `${formatCount(gap.otherItems)} not messages` : ''
		].filter((part) => part !== '');
		return parts.length === 0 ? '' : `(explained: ${parts.join(', ')})`;
	}

	type Open = Folder & { gap: Extract<Folder['gap'], { kind: 'checking' | 'needs-look' }> };

	/** How far a first copy has got: folders done, started (some mail stored), not started. */
	const firstCopy = $derived.by(() => {
		const done = mailbox.folders.filter((folder) => folder.firstCopyDone).length;
		const started = mailbox.folders.filter(
			(folder) => !folder.firstCopyDone && folder.lastSyncedAt !== null
		).length;
		return { done, started, waiting: mailbox.folders.length - done - started };
	});

	/** Folders whose difference nothing explains yet: one line each below the table. */
	const open = $derived(
		mailbox.folders.filter(
			(folder): folder is Open => folder.gap.kind === 'checking' || folder.gap.kind === 'needs-look'
		)
	);

	/** What is missing (or extra), in plain words. */
	function difference(gap: Open['gap']): string {
		return gap.source > gap.stored
			? `${plural(gap.source - gap.stored, 'item')} Microsoft counts ${gap.source - gap.stored === 1 ? 'is' : 'are'} not stored`
			: `${plural(gap.stored - gap.source, 'more message')} stored than Microsoft counts`;
	}

	/** What Lookstow is doing about it, and what (if anything) the admin should do. */
	function action(gap: Open['gap']): string {
		if (gap.kind === 'needs-look') {
			return `Still there a day after Lookstow read the folder again (${formatRelative(gap.recheckedAt)}). Look at this mailbox's failed items and its activity log below.`;
		}
		if (gap.recheckedAt === null) {
			return `Lookstow reads the folder again from the start at its next sync, which copies anything missing. Nothing to do.`;
		}
		return `Lookstow read the folder again ${formatRelative(gap.recheckedAt)}. If the difference is still there ${formatDateTime(new Date(Date.parse(gap.since) + 86_400_000).toISOString())}, it needs a look. Nothing to do yet.`;
	}
</script>

<p class="small"><a href={resolve('/mailboxes')}>Mailboxes</a></p>

<PageHeader
	title={mailbox.address}
	lede={`${mailbox.displayName} · ${KIND_LABELS[mailbox.kind] ?? mailbox.kind}`}
>
	{#snippet actions()}
		{#if data.remote !== null}
			<!-- Remote people only read (docs/specs/SPEC-REMOTE.md). -->
		{:else if mailbox.state === 'excluded'}
			<form method="POST" action="?/include" use:enhance>
				<Button type="submit">Back up again</Button>
			</form>
		{:else if mailbox.goneAt === null}
			<form method="POST" action="?/syncNow" use:enhance>
				<Button type="submit" disabled={mailbox.paused}>Sync now</Button>
			</form>
			<form method="POST" action={mailbox.paused ? '?/resume' : '?/pause'} use:enhance>
				<Button type="submit" variant="secondary">{mailbox.paused ? 'Resume' : 'Pause'}</Button>
			</form>
			{#if !data.picking}
				<Button variant="secondary" onclick={() => (excludeOpen = true)}>Exclude…</Button>
			{/if}
		{/if}
		{#if mailbox.itemCount > 0}
			<form method="GET" action={resolve('/search')}>
				<input type="hidden" name="mailbox" value={mailbox.id} />
				<Button type="submit" variant="secondary">Search this mailbox</Button>
			</form>
			{#if data.remote === null}
				<ConfirmForm
					action="?/deleteBackup"
					variant="ghost"
					question={{
						title: "Delete this mailbox's backup?",
						message: `Every stored message of ${mailbox.address} is deleted from the backup drive (${plural(mailbox.itemCount, 'message')}, ${formatBytes(mailbox.byteCount)}). The files cannot be brought back. If the mailbox is still backed up, its next sync starts a new first copy.`,
						confirmText: 'Delete the backup',
						tone: 'danger',
						match: mailbox.address
					}}>Delete backup…</ConfirmForm
				>
			{/if}
		{/if}
	{/snippet}
</PageHeader>

<Card>
	<DetailView>
		<dt>State</dt>
		<dd><Badge tone={stateTone(mailbox.state)}>{STATE_LABELS[mailbox.state]}</Badge></dd>
		{#if mailbox.lastSyncError !== null}
			<dt>Last error</dt>
			<dd class="error">{mailbox.lastSyncError}</dd>
		{/if}
		{#if mailbox.kind === 'archive'}
			<dt>Archive</dt>
			<dd>
				Copied through Microsoft's mailbox export API. Each item is stored as Exchange's own
				full-fidelity export (<code>.fts</code>), kept exactly as it came. Search finds its items by
				subject, sender and recipient, and each item downloads as an <code>.eml</code> any mail program
				opens.
			</dd>
			{#if mailbox.archiveParts !== null && mailbox.archiveParts > 1}
				<dt>Auto-expanding</dt>
				<dd>
					Microsoft has spread this archive over {mailbox.archiveParts} parts (it does so past 100 GB).
					Lookstow copies every part. Microsoft's count for a folder covers only one part, so a folder
					it counts short is checked against its own full listing instead, every week.
				</dd>
			{/if}
		{/if}
		<dt>Messages</dt>
		<dd>{formatCount(mailbox.itemCount)} ({formatBytes(mailbox.byteCount)})</dd>
		{#if mailbox.unreadableItems > 0}
			<dt>Not readable</dt>
			<dd>
				<Badge tone="warn">{formatCount(mailbox.unreadableItems)}</Badge> archive items could not be read
				for Search. They are stored as they came; the Log names each one. A newer Lookstow tries them
				again.
			</dd>
		{/if}
		<dt>First full copy</dt>
		<dd>
			{#if mailbox.firstCopyDone}
				Done
			{:else}
				Not finished yet: {formatCount(firstCopy.done)} of {formatCount(mailbox.folders.length)}
				folders copied{firstCopy.started > 0
					? `, ${formatCount(firstCopy.started)} in progress`
					: ''}, {formatCount(firstCopy.waiting)} still to start.
			{/if}
		</dd>
		<dt>Last sync</dt>
		<dd>{formatDateTime(mailbox.lastSyncFinishedAt)}</dd>
		<dt>Backup folder</dt>
		<dd><code>{mailbox.backupFolder}</code></dd>
		<dt>First found</dt>
		<dd>{formatDateTime(mailbox.firstSeenAt)}</dd>
		{#if mailbox.goneAt !== null}
			<dt>Gone from Microsoft 365</dt>
			<dd>{formatDateTime(mailbox.goneAt)}. The backup is kept.</dd>
		{/if}
	</DetailView>
</Card>

<Card title="Folders">
	{#if mailbox.folders.length === 0}
		<p class="muted">No folders yet: they are listed on the first sync.</p>
	{:else}
		<DataTable
			columns={['Folder', 'Messages', 'Microsoft says', 'First copy', 'Last synced']}
			rows={mailbox.folders}
			key={(folder: RowFolder) => folder.path}
		>
			{#snippet cells(folder: RowFolder)}
				<td>{folder.path}</td>
				<td>{formatCount(folder.itemCount)}</td>
				<td>
					{#if folder.gap.kind === 'from-listing'}
						{formatCount(folder.sourceCount ?? 0)}
						<span class="muted small"
							>(one part only; its full listing {folder.gap.listedAt === null
								? 'is due'
								: `on ${formatDateTime(folder.gap.listedAt)} found ${formatCount(folder.gap.listed ?? 0)}`})</span
						>
					{:else if folder.sourceCount === null}
						<span class="muted">Not compared</span>
					{:else if folder.gap.kind === 'needs-look'}
						<Badge tone="warn">{formatCount(folder.sourceCount)}</Badge>
						<span class="muted small">(needs a look)</span>
					{:else if folder.gap.kind === 'checking'}
						<Badge tone="info">{formatCount(folder.sourceCount)}</Badge>
						<span class="muted small">(checking)</span>
					{:else}
						{formatCount(folder.sourceCount)}
						{#if folder.gap.kind === 'explained'}
							<span class="muted small">{explainedText(folder.gap)}</span>
						{/if}
						{#if folder.listedCount !== null && folder.listedCount !== folder.sourceCount}
							<span class="muted small">(last full listing: {formatCount(folder.listedCount)})</span
							>
						{/if}
					{/if}
				</td>
				<td>{folder.firstCopyDone ? 'Done' : 'In progress'}</td>
				<td>{formatRelative(folder.lastSyncedAt)}</td>
			{/snippet}
		</DataTable>
		{#if open.length > 0}
			<div class="differences-head">
				<h3>Differences from Microsoft</h3>
				{#if data.remote === null}
					<form method="POST" action="?/recheck" use:enhance>
						<Button type="submit" size="sm" variant="secondary">Check again now</Button>
					</form>
				{/if}
			</div>
			<ul class="plain">
				{#each open as folder (folder.path)}
					<li>
						<Badge tone={folder.gap.kind === 'needs-look' ? 'warn' : 'info'}
							>{folder.gap.kind === 'needs-look' ? 'Needs a look' : 'Checking'}</Badge
						>
						<strong>{folder.path}</strong>: {difference(folder.gap)} ({formatCount(
							folder.gap.stored
						)} stored, Microsoft says {formatCount(folder.gap.source)}), since {formatRelative(
							folder.gap.since
						)}. {action(folder.gap)} Last checked {formatRelative(folder.lastSyncedAt)}.
					</li>
				{/each}
			</ul>
		{/if}
		<p class="muted small">
			Microsoft's count is read after each folder syncs. Hidden folders and folders that do not hold
			mail (Outlook's PersonMetadata, contacts, calendars) are not compared. Items waiting to be
			copied again, and items that are not messages (Deleted Items can hold meeting requests and
			contacts), explain a higher count. Any other difference is Checking: Lookstow reads the folder
			again from the start at most once a day. It needs a look only if it is still there a day after
			that, and only then does it alert.
		</p>
	{/if}
</Card>

{#if data.failures.total > 0}
	<Card title={`Items that could not be copied (${formatCount(data.failures.total)})`} tone="warn">
		{#snippet actions()}
			{#if data.remote === null}
				<form method="POST" action="?/retryFailures" use:enhance>
					<Button type="submit" variant="secondary">Try again now</Button>
				</form>
			{/if}
		{/snippet}
		<p class="small muted">
			Microsoft refused these items, or their download kept breaking. The rest of each folder is
			copied; these are tried again after 15 minutes, 1 hour, 4 hours and then daily, five times in
			all. They also explain why a folder's count from Microsoft can be higher than what is stored.
		</p>
		<DataTable
			columns={['Folder', 'Subject', 'Received', 'Tries', 'Problem']}
			rows={data.failures.items}
			key={(failure: RowFailure) => failure.graphId}
		>
			{#snippet cells(failure: RowFailure)}
				<td>{failure.folderPath}</td>
				<td>{failure.subject === '' ? '—' : failure.subject}</td>
				<td>{formatDateTime(failure.receivedAt)}</td>
				<td>
					{failure.attempts}
					{#if failure.terminal}<Badge tone="bad">Stopped</Badge>{:else}<span class="small muted"
							>next {formatRelative(failure.nextTryAt)}</span
						>{/if}
				</td>
				<td class="small">{failure.lastError}</td>
			{/snippet}
		</DataTable>
	</Card>
{/if}

<Card title="Recent syncs">
	{#if mailbox.recentRuns.length === 0}
		<p class="muted">Not synced yet.</p>
	{:else}
		<DataTable
			columns={['Started', 'Result', 'Stored', 'Deleted at source']}
			rows={mailbox.recentRuns}
			key={(run: RowRun) => run.id}
		>
			{#snippet cells(run: RowRun)}
				<td>{formatDateTime(run.startedAt)}</td>
				<td>
					<Badge tone={run.outcome === 'ok' ? 'ok' : run.outcome === 'running' ? 'info' : 'bad'}
						>{run.outcome}</Badge
					>
					{#if run.error !== null}<div class="small error">{run.error}</div>{/if}
				</td>
				<td>{formatCount(run.added)} ({formatBytes(run.byteCount)})</td>
				<td>{formatCount(run.removed)}</td>
			{/snippet}
		</DataTable>
	{/if}
</Card>

{#if data.activity.length > 0}
	<Card title="Activity">
		<DataTable
			columns={['When', 'What']}
			rows={data.activity}
			key={(entry: RowEntry) => entry.id}
			compact
		>
			{#snippet cells(entry: RowEntry)}
				<td class="nowrap">{formatDateTime(entry.at)}</td>
				<td>{entry.summary}</td>
			{/snippet}
		</DataTable>
	</Card>
{/if}

<FormModal
	bind:open={excludeOpen}
	title="Exclude this mailbox?"
	action="?/exclude"
	submitLabel="Exclude"
	variant="danger"
>
	<p>
		Lookstow stops backing up <strong>{mailbox.address}</strong>. You can back it up again at any
		time.
	</p>
	<ExistingBackupChoice
		address={mailbox.address}
		itemCount={mailbox.itemCount}
		byteCount={mailbox.byteCount}
	/>
</FormModal>

<style>
	.error {
		color: var(--colour-bad);
	}

	.nowrap {
		white-space: nowrap;
	}

	form {
		display: contents;
	}

	.differences-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
</style>
