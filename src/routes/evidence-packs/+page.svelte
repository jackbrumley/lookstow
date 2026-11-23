<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';
	import Callout from '#lib/ui/callout.svelte';
	import DetailView from '#lib/ui/detail-view.svelte';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import DataTable from '#lib/ui/data-table.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { toastFormResult } from '#lib/utils/form-toast.ts';
	import { formatBytes, formatCount, formatDateTime } from '#lib/utils/format.ts';
	import { PACK_KEEP_DAYS, PACK_MAX_MESSAGES, packProgress } from '#lib/domain/evidence-packs.ts';

	let { data, form }: PageProps = $props();

	type RowRow = PageProps['data']['packs'][number];

	$effect(() => {
		toastFormResult(form);
	});

	const preview = $derived(form !== null && 'preview' in form ? form.preview : null);
	const busy = $derived(
		data.packs.some((pack) => pack.status === 'queued' || pack.status === 'building')
	);
	let working = $state(false);

	// While a pack is being made the list follows it every few seconds.
	onMount(() => {
		const timer = setInterval(() => {
			if (busy) void refreshAll();
		}, 3_000);
		return () => {
			clearInterval(timer);
		};
	});

	function tone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
		if (status === 'ready') return 'ok';
		if (status === 'failed') return 'bad';
		return 'warn';
	}

	const LABELS: Record<string, string> = {
		queued: 'Waiting',
		building: 'Being made',
		ready: 'Ready',
		failed: 'Failed'
	};

	function mine(createdBy: string): boolean {
		return data.isLocal || createdBy === data.me;
	}

	// A check's answer shows in a window, until it is closed or the pack is made from it.
	let dismissed = $state<unknown>(null);
	const checked = $derived(preview !== null && preview !== dismissed ? preview : null);

	// The pack opened from the list, as it stands now (the list follows a pack being made).
	let viewing = $state<string | null>(null);
	let viewOpen = $state(false);
	const pack = $derived(data.packs.find((each) => each.id === viewing));

	function closeOnSuccess(): ReturnType<SubmitFunction> {
		return async ({ result, update }) => {
			await update();
			if (result.type === 'success') viewOpen = false;
		};
	}
</script>

<svelte:head><title>Evidence packs · Lookstow</title></svelte:head>

<PageHeader
	title="Evidence packs"
	lede="One ZIP file of chosen messages, each exactly as stored, with a manifest and SHA-256s, to hand to a lawyer."
/>

<Card title="Make a pack">
	<form
		method="POST"
		action="?/check"
		id="make-pack"
		class="make"
		use:enhance={({ action }) => {
			working = true;
			const building = action.search.includes('build');
			return async ({ update, result }) => {
				await update({ reset: building && result.type === 'success' });
				working = false;
			};
		}}
	>
		<label>
			Message ids
			<textarea
				name="ids"
				rows="8"
				required
				placeholder="Paste message ids, one per line, or links to /messages/…, or a column from a spreadsheet"
			></textarea>
		</label>
		<p class="muted small">
			Lookstow picks the ids out of whatever is pasted, and leaves out repeats. Up to {formatCount(
				PACK_MAX_MESSAGES
			)} messages a pack.
		</p>
		<label>
			Name
			<input name="name" maxlength="80" placeholder="For example: Timesheets 2023, for counsel" />
		</label>
		<label class="check">
			<input type="checkbox" name="withAttachments" />
			Also put each attachment in as its own file (easier to look through; the pack is about twice as
			big)
		</label>
		<div class="buttons">
			<Button type="submit" variant="secondary" disabled={working}>Check</Button>
			<Button type="submit" formaction="?/build" disabled={working}
				>{working ? 'Working…' : 'Make the pack'}</Button
			>
		</div>
	</form>
</Card>

<Card title="Packs">
	{#if data.packs.length === 0}
		<p class="muted">No packs yet. Packs are kept for {PACK_KEEP_DAYS} days, then removed.</p>
	{:else}
		<DataTable
			columns={['Name', 'State', 'Messages', 'Size', 'Made']}
			rows={data.packs}
			key={(row: RowRow) => row.id}
			label={(row: RowRow) => row.name}
			onopen={(row: RowRow) => {
				viewing = row.id;
				viewOpen = true;
			}}
		>
			{#snippet first(row: RowRow)}
				<div class="muted small">by {row.createdBy}</div>
			{/snippet}
			{#snippet cells(row: RowRow)}
				<td>
					<Badge tone={tone(row.status)}>{LABELS[row.status]}</Badge>
					<div class="small">{packProgress(row)}</div>
					{#if row.status === 'building' && row.total > 0}
						<progress max={row.total} value={row.done}></progress>
					{/if}
					{#if row.mismatched > 0 || row.unreadable > 0}
						<div class="small problem">Some messages need a look: open the pack</div>
					{/if}
				</td>
				<td>{formatCount(row.total)}</td>
				<td>{row.zipBytes === null ? '' : formatBytes(row.zipBytes)}</td>
				<td>{formatDateTime(row.createdAt)}</td>
			{/snippet}
		</DataTable>
		<p class="muted small">Click a pack to download it, see its SHA-256 or remove it.</p>
		<p class="muted small">
			Packs are kept in the data folder for {PACK_KEEP_DAYS} days, then removed. Check a copy with
			<code>Get-FileHash &lt;file&gt;.zip</code> (PowerShell) against its SHA-256 here.
		</p>
	{/if}
</Card>

<Modal
	open={checked !== null}
	title={checked === null ? 'Check' : `${formatCount(checked.found)} messages found`}
	onclose={() => (dismissed = checked)}
>
	{#if checked !== null}
		<p>
			<strong>{formatCount(checked.found)}</strong> messages found ({formatBytes(
				checked.sourceBytes
			)} as stored){#if checked.repeats > 0}, {formatCount(checked.repeats)} repeats left out{/if}.
			{#if checked.freeBytes !== null}{formatBytes(checked.freeBytes)} free on the data folder’s drive.{/if}
		</p>
		{#if checked.missingCount > 0}
			<p>
				{formatCount(checked.missingCount)} ids are not in the backup and are left out (the pack’s README
				lists them):
			</p>
			<pre class="missing">{checked.missing.join('\n')}{checked.missingCount >
				checked.missing.length
					? '\n…'
					: ''}</pre>
		{/if}
		{#if checked.refusal !== null}<Callout tone="danger">{checked.refusal}</Callout>{/if}
	{/if}
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (dismissed = checked)}>Close</Button>
		{#if checked !== null && checked.refusal === null}
			<Button type="submit" form="make-pack" formaction="?/build" disabled={working}
				>{working ? 'Working…' : 'Make the pack'}</Button
			>
		{/if}
	{/snippet}
</Modal>

<Modal bind:open={viewOpen} title={pack === undefined ? 'Evidence pack' : pack.name}>
	{#if pack !== undefined}
		<DetailView>
			<dt>State</dt>
			<dd>
				<Badge tone={tone(pack.status)}>{LABELS[pack.status]}</Badge>
				{packProgress(pack)}
				{#if pack.status === 'building' && pack.total > 0}
					<progress max={pack.total} value={pack.done}></progress>
				{/if}
			</dd>
			<dt>Made by</dt>
			<dd>{pack.createdBy}, {formatDateTime(pack.createdAt)}</dd>
			<dt>Messages</dt>
			<dd>
				{formatCount(pack.total)}{pack.withAttachments ? ', attachments as their own files' : ''}
			</dd>
			{#if pack.zipBytes !== null}
				<dt>Size</dt>
				<dd>{formatBytes(pack.zipBytes)}</dd>
			{/if}
			{#if pack.sha256 !== null}
				<dt>SHA-256</dt>
				<dd><code class="sha">{pack.sha256}</code></dd>
			{/if}
			{#if pack.expiresAt !== null}
				<dt>Kept until</dt>
				<dd>{formatDateTime(pack.expiresAt)}</dd>
			{/if}
			{#if pack.missing.length > 0}
				<dt>Not in the backup</dt>
				<dd>{formatCount(pack.missing.length)} ids (the README lists them)</dd>
			{/if}
			{#if pack.mismatched > 0}
				<dt>No longer match</dt>
				<dd class="problem">
					{formatCount(pack.mismatched)} stored files no longer match their SHA-256 (see the README)
				</dd>
			{/if}
			{#if pack.unreadable > 0}
				<dt>Could not be read</dt>
				<dd class="problem">{formatCount(pack.unreadable)}</dd>
			{/if}
			{#if pack.problem !== null}
				<dt>Problem</dt>
				<dd class="problem">{pack.problem}</dd>
			{/if}
		</DetailView>
	{/if}
	{#snippet footer()}
		{#if pack !== undefined}
			{#if mine(pack.createdBy)}
				<form method="POST" action="?/remove" use:enhance={closeOnSuccess}>
					<input type="hidden" name="id" value={pack.id} />
					<Button type="submit" variant="danger"
						>{pack.status === 'ready' || pack.status === 'failed' ? 'Remove' : 'Stop'}</Button
					>
				</form>
				{#if pack.status === 'failed'}
					<form method="POST" action="?/again" use:enhance>
						<input type="hidden" name="id" value={pack.id} />
						<Button type="submit" variant="secondary">Make again</Button>
					</form>
				{/if}
			{/if}
			{#if pack.status === 'ready'}
				<Button href={resolve('/evidence-packs/[id]/download', { id: pack.id })}>Download</Button>
			{/if}
		{/if}
	{/snippet}
</Modal>

<style>
	.make {
		display: grid;
		gap: var(--space-3);
	}

	label {
		display: grid;
		gap: var(--space-1);
		font-weight: var(--font-weight-medium);
	}

	label.check {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		font-weight: normal;
	}

	textarea {
		font-family: var(--font-mono, monospace);
	}

	.buttons {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.sha {
		word-break: break-all;
	}

	.missing {
		max-height: 10rem;
		overflow: auto;
		font-size: var(--font-size-sm);
		margin: 0;
	}

	progress {
		width: 8rem;
	}

	.problem {
		color: var(--colour-bad-text);
	}

	.muted {
		color: var(--colour-text-muted);
	}

	.small {
		font-size: var(--font-size-sm);
	}
</style>
