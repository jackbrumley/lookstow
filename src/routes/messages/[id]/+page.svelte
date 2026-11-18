<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatBytes, formatDateTime } from '#lib/utils/format.ts';
	import type { MessageEvent } from '#lib/domain/messages.ts';

	let { data }: PageProps = $props();

	const message = $derived(data.message);
	const archive = $derived(message.mailboxKind === 'archive');

	function describe(event: MessageEvent): string {
		switch (event.kind) {
			case 'stored':
				return `Stored, in ${event.toFolderPath ?? 'an unknown folder'}`;
			case 'moved':
				return `Moved from ${event.fromFolderPath ?? '?'} to ${event.toFolderPath ?? '?'}`;
			case 'deleted':
				return `Deleted in Microsoft 365 (was in ${event.fromFolderPath ?? '?'}). The stored copy is kept.`;
			case 'restored':
				return `Back in Microsoft 365, in ${event.toFolderPath ?? '?'}`;
		}
	}
</script>

<p class="small"><a href={resolve('/search')}>Search</a></p>

<PageHeader
	title={message.subject === '' ? (archive ? 'Archive item' : '(no subject)') : message.subject}
	lede={`${message.mailboxAddress}${archive ? ' (online archive)' : ''} · ${message.folderPath}`}
>
	{#snippet actions()}
		<Button href={resolve('/messages/[id]/download', { id: message.id })}
			>Download {archive ? '.fts' : '.eml'}</Button
		>
	{/snippet}
</PageHeader>

<Card>
	<dl class="facts">
		{#if message.deletedAt !== null}
			<dt>State</dt>
			<dd>
				<Badge tone="warn">Deleted in Microsoft 365</Badge>
				{formatDateTime(message.deletedAt)}. The stored copy is kept.
			</dd>
		{/if}
		{#if !archive}
			<dt>From</dt>
			<dd>{message.sender === '' ? '—' : message.sender}</dd>
			<dt>To and Cc</dt>
			<dd>{message.recipients === '' ? 'Not recorded' : message.recipients}</dd>
		{/if}
		<dt>{archive ? 'Created' : 'Received'}</dt>
		<dd>{formatDateTime(message.receivedAt)}</dd>
		<dt>Mailbox</dt>
		<dd>
			<a href={resolve('/mailboxes/[id]', { id: message.mailboxId })}>{message.mailboxAddress}</a>
		</dd>
		<dt>Folder</dt>
		<dd>{message.folderPath}</dd>
		<dt>Size</dt>
		<dd>{formatBytes(message.byteCount)}</dd>
		<dt>Stored</dt>
		<dd>{formatDateTime(message.storedAt)}</dd>
		<dt>File</dt>
		<dd><code>{message.filePath}</code></dd>
		{#if archive}
			<dt>Format</dt>
			<dd>
				Exchange's full-fidelity export (<code>.fts</code>): complete, and importable into a
				mailbox, but mail programs cannot open it.
			</dd>
		{/if}
		<dt>SHA-256</dt>
		<dd><code>{message.sha256}</code></dd>
		{#if message.internetMessageId !== null}
			<dt>Message-ID</dt>
			<dd><code>{message.internetMessageId}</code></dd>
		{/if}
		<dt>Microsoft 365 id</dt>
		<dd><code class="small">{message.graphId}</code></dd>
	</dl>
</Card>

<Card title="History">
	{#if message.history.length === 0}
		<p class="muted">
			No history: this message was stored before Lookstow kept folder history (version 0.4).
		</p>
	{:else}
		<ul class="history">
			{#each message.history as event, index (index)}
				<li><span class="muted small">{formatDateTime(event.at)}</span> {describe(event)}</li>
			{/each}
		</ul>
	{/if}
</Card>

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

	.history {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}
</style>
