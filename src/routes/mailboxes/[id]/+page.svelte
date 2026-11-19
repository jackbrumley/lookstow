<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import FormModal from '#lib/ui/form-modal.svelte';
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

	$effect(() => {
		toastFormResult(form);
	});

	let excludeOpen = $state(false);
	let deleteOpen = $state(false);
	const mailbox = $derived(data.mailbox);
</script>

<p class="small"><a href={resolve('/mailboxes')}>Mailboxes</a></p>

<PageHeader
	title={mailbox.address}
	lede={`${mailbox.displayName} · ${KIND_LABELS[mailbox.kind] ?? mailbox.kind}`}
>
	{#snippet actions()}
		{#if mailbox.state === 'excluded'}
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
			<Button variant="ghost" onclick={() => (deleteOpen = true)}>Delete backup…</Button>
		{/if}
	{/snippet}
</PageHeader>

<Card>
	<dl class="facts">
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
		<dd>{mailbox.firstCopyDone ? 'Done' : 'Not finished yet'}</dd>
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
	</dl>
</Card>

<Card title="Folders">
	{#if mailbox.folders.length === 0}
		<p class="muted">No folders yet: they are listed on the first sync.</p>
	{:else}
		<table>
			<thead
				><tr
					><th>Folder</th><th>Messages</th><th>Microsoft says</th><th>First copy</th><th
						>Last synced</th
					></tr
				></thead
			>
			<tbody>
				{#each mailbox.folders as folder (folder.path)}
					<tr>
						<td>{folder.path}</td>
						<td>{formatCount(folder.itemCount)}</td>
						<td>
							{#if folder.sourceCount === null}
								<span class="muted">Not yet</span>
							{:else if folder.sourceCount === folder.itemCount}
								{formatCount(folder.sourceCount)}
							{:else}
								<Badge tone="warn">{formatCount(folder.sourceCount)}</Badge>
							{/if}
						</td>
						<td>{folder.firstCopyDone ? 'Done' : 'In progress'}</td>
						<td>{formatRelative(folder.lastSyncedAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if mailbox.differsFromMicrosoft}
			<p class="muted small">
				Where Microsoft's count differs from the stored messages, it is marked. Small differences
				are normal: mail that arrived during the last sync, and items in a mail folder that are not
				messages (Deleted Items can hold contacts and calendar items). The numbers are shown as they
				are, and checked again at every sync.
			</p>
		{/if}
	{/if}
</Card>

{#if data.failures.total > 0}
	<Card title={`Items that could not be copied (${formatCount(data.failures.total)})`} tone="warn">
		{#snippet actions()}
			<form method="POST" action="?/retryFailures" use:enhance>
				<Button type="submit" variant="secondary">Try again now</Button>
			</form>
		{/snippet}
		<p class="small muted">
			Microsoft refused these items, or their download kept breaking. The rest of each folder is
			copied; these are tried again after 15 minutes, 1 hour, 4 hours and then daily, five times in
			all. They also explain why a folder's count from Microsoft can be higher than what is stored.
		</p>
		<table>
			<thead
				><tr><th>Folder</th><th>Subject</th><th>Received</th><th>Tries</th><th>Problem</th></tr
				></thead
			>
			<tbody>
				{#each data.failures.items as failure (failure.graphId)}
					<tr>
						<td>{failure.folderPath}</td>
						<td>{failure.subject === '' ? '—' : failure.subject}</td>
						<td>{formatDateTime(failure.receivedAt)}</td>
						<td>
							{failure.attempts}
							{#if failure.terminal}<Badge tone="bad">Stopped</Badge>{:else}<span
									class="small muted">next {formatRelative(failure.nextTryAt)}</span
								>{/if}
						</td>
						<td class="small">{failure.lastError}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</Card>
{/if}

<Card title="Recent syncs">
	{#if mailbox.recentRuns.length === 0}
		<p class="muted">Not synced yet.</p>
	{:else}
		<table>
			<thead
				><tr><th>Started</th><th>Result</th><th>Stored</th><th>Deleted at source</th></tr></thead
			>
			<tbody>
				{#each mailbox.recentRuns as run (run.id)}
					<tr>
						<td>{formatDateTime(run.startedAt)}</td>
						<td>
							<Badge tone={run.outcome === 'ok' ? 'ok' : run.outcome === 'running' ? 'info' : 'bad'}
								>{run.outcome}</Badge
							>
							{#if run.error !== null}<div class="small error">{run.error}</div>{/if}
						</td>
						<td>{formatCount(run.added)} ({formatBytes(run.byteCount)})</td>
						<td>{formatCount(run.removed)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</Card>

{#if data.activity.length > 0}
	<Card title="Activity">
		<ul class="activity">
			{#each data.activity as entry (entry.id)}
				<li><span class="muted small">{formatDateTime(entry.at)}</span> {entry.summary}</li>
			{/each}
		</ul>
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

<FormModal
	bind:open={deleteOpen}
	title="Delete this mailbox's backup?"
	action="?/deleteBackup"
	submitLabel="Delete the backup"
	variant="danger"
>
	<p>
		Every stored message of <strong>{mailbox.address}</strong> is deleted from the backup drive ({plural(
			mailbox.itemCount,
			'message'
		)}, {formatBytes(mailbox.byteCount)}). The files cannot be brought back. If the mailbox is still
		backed up, its next sync starts a new first copy.
	</p>
	<label class="confirm">
		Type <strong>{mailbox.address}</strong> to confirm.
		<input name="confirm" autocomplete="off" required />
	</label>
</FormModal>

<style>
	.facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-2) var(--space-4);
		margin: 0;
	}

	.facts dt {
		color: var(--colour-text-muted);
	}

	.facts dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.confirm {
		display: grid;
		gap: var(--space-1);
		margin-top: var(--space-3);
	}

	.error {
		color: var(--colour-bad);
	}

	.activity {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}

	form {
		display: contents;
	}
</style>
