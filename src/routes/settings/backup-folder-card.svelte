<!--
	BackupFolderCard: where the backup is, its index snapshots, and moving it to another folder
	(docs/specs/SPEC-BACKUP-FOLDER-MOVE.md). Change is offered only while nothing is stored; once
	mail is stored, the only way to another folder is Move, which copies and checks every file.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import FormModal from '#lib/ui/form-modal.svelte';
	import type { BackupMoveStatus } from '#lib/domain/engine.ts';
	import { formatBytes, formatCount, formatDateTime, plural } from '#lib/utils/format.ts';

	type Snapshots =
		| { kind: 'unreadable'; folder: string; reason: string }
		| {
				kind: 'listed';
				folder: string;
				kept: number;
				newest: { takenAt: string; bytes: number } | null;
				drive: 'same' | 'different' | 'unknown';
		  };

	interface Props {
		root: string | null;
		effectiveRoot: string;
		storedFiles: number;
		move: BackupMoveStatus;
		snapshots: Snapshots;
	}

	let { root, effectiveRoot, storedFiles, move, snapshots }: Props = $props();

	let changeOpen = $state(false);
	let moveOpen = $state(false);
	let removeOpen = $state(false);
	let removeTyped = $state('');
	const percent = $derived(
		move.kind === 'moving' && move.totalBytes > 0
			? Math.min(100, Math.round((move.bytes / move.totalBytes) * 100))
			: 0
	);
</script>

<Card title="Backup folder">
	{#snippet actions()}
		{#if move.kind === 'none'}
			{#if storedFiles === 0}
				<Button variant="secondary" onclick={() => (changeOpen = true)}>Change…</Button>
			{:else}
				<Button variant="secondary" onclick={() => (moveOpen = true)}>Move…</Button>
			{/if}
		{:else if move.kind === 'moving'}
			<form method="POST" action="?/cancelMove" use:enhance>
				<Button type="submit" variant="secondary">Stop the move</Button>
			</form>
		{:else if move.removing === null}
			<Button variant="danger" onclick={() => (removeOpen = true)}>Remove the old copy…</Button>
		{/if}
	{/snippet}
	<p>
		<code>{effectiveRoot}</code>{root === null ? ' (the default)' : ''}
	</p>
	{#if move.kind === 'moving'}
		<p>
			<Badge tone="warn">Moving</Badge>
			{#if move.phase === 'waiting'}
				Waiting for running syncs to stop, then copying to <code>{move.to}</code>.
			{:else if move.phase === 'copying'}
				Copying to <code>{move.to}</code>: {formatCount(move.files)} files, {formatBytes(
					move.bytes
				)} of about {formatBytes(move.totalBytes)} ({percent}%). Every copy is checked against the
				index.
			{:else}
				Checking the copy in <code>{move.to}</code> against the index.
			{/if}
		</p>
		<p class="muted small">
			Backups, discovery and changes to what is backed up wait until the move ends. Stop the move
			keeps the backup where it is; the files copied so far stay in the new folder, and a later move
			there carries on from them.
		</p>
	{:else if move.kind === 'moved'}
		<p>
			<Badge tone="ok">Moved</Badge>
			{formatDateTime(move.finishedAt)}: {plural(move.files, 'file')} ({formatBytes(move.bytes)})
			copied from <code>{move.from}</code> and checked.
			{#if move.problems > 0}
				<Badge tone="warn">{plural(move.problems, 'file')} not checked</Badge> See the activity log.
			{/if}
		</p>
		<p class="muted small">
			{#if move.removing !== null}
				Removing the old copy: {formatCount(move.removing)} files so far.
			{:else}
				The old copy in <code>{move.from}</code> is kept until you remove it. Remove it once you are happy
				the backup is complete in its new place.
			{/if}
		</p>
	{:else}
		<p class="muted small">
			One folder per mailbox, then one folder per year and month, then one file per message: .eml
			for mailboxes (any mail program opens them), .fts for online archives. A small file,
			<code>.lookstow-backup</code>, marks the folder: if it is missing (a drive not attached),
			backups stop rather than start again somewhere else.
		</p>
	{/if}
	<h3>Index snapshots</h3>
	{#if snapshots.kind === 'unreadable'}
		<p>
			<Badge tone="bad">Unreadable</Badge> Lookstow cannot read <code>{snapshots.folder}</code>: {snapshots.reason}
		</p>
	{:else}
		<p>
			{#if snapshots.newest === null}
				<Badge tone="warn">None yet</Badge> The first copy is made once the start-up work is done.
			{:else}
				Last copy {formatDateTime(snapshots.newest.takenAt)} ({formatBytes(
					snapshots.newest.bytes
				)}).
				{plural(snapshots.kept, 'copy', 'copies')} kept, the newest 7, in
				<code>{snapshots.folder}</code>.
			{/if}
		</p>
		{#if snapshots.drive === 'same'}
			<p class="muted small">
				The copies are on the same drive as the index. They survive a damaged index, not the loss of
				that drive. A backup folder on another drive protects against both.
			</p>
		{/if}
	{/if}
	<p class="muted small">
		The index is Lookstow's record of every message's folder and history. It is copied here once a
		day. If it is ever lost, How it works says how to put a copy back.
	</p>
</Card>

<FormModal bind:open={changeOpen} title="Backup folder" action="?/backup">
	<label>
		Full path (leave empty for the default)
		<input name="root" value={root ?? ''} placeholder={effectiveRoot} autocomplete="off" />
	</label>
	<p class="muted small">
		Nothing is stored yet, so the folder can simply change. Once mail is stored, use Move instead. A
		folder outside the data folder must be prepared first: on the server, as an administrator, run <code
			>lookstow backup-folder prepare "&lt;folder&gt;"</code
		>.
	</p>
</FormModal>

<FormModal
	bind:open={moveOpen}
	title="Move the backup"
	action="?/move"
	submitLabel="Move the backup"
	busyLabel="Checking the folder…"
>
	<ol class="small">
		<li>
			On the server, as an administrator, prepare the new folder (it must be empty):
			<code>lookstow backup-folder prepare "D:\Lookstow backup"</code> on Windows, or
			<code>sudo lookstow backup-folder prepare /srv/lookstow-backup</code> on Linux.
		</li>
		<li>Enter it here.</li>
	</ol>
	<label>
		New folder (full path)
		<input name="to" required autocomplete="off" />
	</label>
	<p class="muted small">
		Lookstow stops backups, copies all {formatCount(storedFiles)} stored files and the index snapshots
		to the new folder, and checks each copy against the index. Only then does it switch to the new folder
		and start backups again. The old copy stays until you remove it. If the service restarts during the
		move, it carries on from where it was.
	</p>
</FormModal>

<FormModal
	bind:open={removeOpen}
	title="Remove the old copy"
	action="?/removeOld"
	submitLabel="Remove the old copy"
	variant="danger"
	canSubmit={removeTyped.trim() === 'REMOVE'}
>
	{#if move.kind === 'moved'}
		<p>
			This deletes the old copy in <code>{move.from}</code>. Each file is deleted only when its copy
			in <code>{move.to}</code> has the same contents; any other is kept and named in the activity log.
		</p>
	{/if}
	<label>
		Type REMOVE to confirm
		<input name="confirm" bind:value={removeTyped} autocomplete="off" />
	</label>
</FormModal>
