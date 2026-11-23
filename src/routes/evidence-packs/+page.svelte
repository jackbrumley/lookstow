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
	import { formatBytes, formatCount, formatDateTime } from '#lib/utils/format.ts';
	import { PACK_KEEP_DAYS, PACK_MAX_MESSAGES, packProgress } from '#lib/domain/evidence-packs.ts';

	let { data, form }: PageProps = $props();

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
		{#if preview !== null}
			<div class="preview" class:bad={preview.refusal !== null}>
				<p>
					<strong>{formatCount(preview.found)}</strong> messages found ({formatBytes(
						preview.sourceBytes
					)} as stored){#if preview.repeats > 0}, {formatCount(preview.repeats)} repeats left out{/if}.
					{#if preview.freeBytes !== null}{formatBytes(preview.freeBytes)} free on the data folder’s drive.{/if}
				</p>
				{#if preview.missingCount > 0}
					<p>
						{formatCount(preview.missingCount)} ids are not in the backup and are left out (the pack’s
						README lists them):
					</p>
					<pre class="missing">{preview.missing.join('\n')}{preview.missingCount >
						preview.missing.length
							? '\n…'
							: ''}</pre>
				{/if}
				{#if preview.refusal !== null}<p class="problem">{preview.refusal}</p>{/if}
			</div>
		{/if}
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
		<table>
			<thead>
				<tr><th>Name</th><th>State</th><th>Messages</th><th>Size</th><th>Made</th><th></th></tr>
			</thead>
			<tbody>
				{#each data.packs as pack (pack.id)}
					<tr>
						<td>
							<strong>{pack.name}</strong>
							<div class="muted small">by {pack.createdBy}</div>
							{#if pack.sha256 !== null}
								<div class="muted small sha">SHA-256 <code>{pack.sha256}</code></div>
							{/if}
						</td>
						<td>
							<Badge tone={tone(pack.status)}>{LABELS[pack.status]}</Badge>
							<div class="small">{packProgress(pack)}</div>
							{#if pack.status === 'building' && pack.total > 0}
								<progress max={pack.total} value={pack.done}></progress>
							{/if}
							{#if pack.missing.length > 0}
								<div class="small muted">
									{formatCount(pack.missing.length)} ids not in the backup
								</div>
							{/if}
							{#if pack.mismatched > 0}
								<div class="small problem">
									{formatCount(pack.mismatched)} stored files no longer match their SHA-256 (see the README)
								</div>
							{/if}
							{#if pack.unreadable > 0}
								<div class="small problem">{formatCount(pack.unreadable)} could not be read</div>
							{/if}
						</td>
						<td>{formatCount(pack.total)}</td>
						<td>{pack.zipBytes === null ? '' : formatBytes(pack.zipBytes)}</td>
						<td>
							{formatDateTime(pack.createdAt)}
							{#if pack.expiresAt !== null}
								<div class="muted small">kept until {formatDateTime(pack.expiresAt)}</div>
							{/if}
						</td>
						<td class="row-actions">
							{#if pack.status === 'ready'}
								<Button size="sm" href={resolve('/evidence-packs/[id]/download', { id: pack.id })}
									>Download</Button
								>
							{/if}
							{#if mine(pack.createdBy)}
								{#if pack.status === 'failed'}
									<form method="POST" action="?/again" use:enhance>
										<input type="hidden" name="id" value={pack.id} />
										<Button type="submit" size="sm" variant="secondary">Make again</Button>
									</form>
								{/if}
								<form method="POST" action="?/remove" use:enhance>
									<input type="hidden" name="id" value={pack.id} />
									<Button type="submit" size="sm" variant="ghost"
										>{pack.status === 'ready' || pack.status === 'failed'
											? 'Remove'
											: 'Stop'}</Button
									>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="muted small">
			Packs are kept in the data folder for {PACK_KEEP_DAYS} days, then removed. Check a copy with
			<code>Get-FileHash &lt;file&gt;.zip</code> (PowerShell) against its SHA-256 here.
		</p>
	{/if}
</Card>

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

	.buttons,
	.row-actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.row-actions {
		justify-content: flex-end;
	}

	.preview {
		background: var(--colour-surface-muted, var(--colour-border));
		padding: var(--space-3);
		border-radius: var(--radius-md);
	}

	.preview p {
		margin: 0 0 var(--space-2);
	}

	.preview.bad {
		background: var(--colour-bad-soft);
	}

	.missing {
		max-height: 10rem;
		overflow: auto;
		font-size: var(--font-size-sm);
		margin: 0;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		text-align: left;
		padding: var(--space-2);
		border-bottom: 1px solid var(--colour-border);
		vertical-align: top;
	}

	.sha code {
		word-break: break-all;
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
