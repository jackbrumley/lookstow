<script lang="ts">
	import { resolve } from '$app/paths';
	import DetailView from '#lib/ui/detail-view.svelte';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatBytes, formatDateTime } from '#lib/utils/format.ts';
	import type { MessageEvent } from '#lib/domain/messages.ts';
	import type { MessagePageData } from '#lib/domain/viewer.ts';
	import type { ResolvedPathname } from '$app/types';
	import Lightbox, { type LightboxItem } from '#lib/ui/lightbox.svelte';

	/** A message's page, or a forwarded email's inside it (`data.part`): the same page. */
	let { data }: { data: MessagePageData } = $props();

	const message = $derived(data.message);
	const archive = $derived(message.mailboxKind === 'archive');
	const view = $derived(data.view);

	// The viewer (docs/specs/SPEC-VIEWER.md). The frame's address is not a link, so it may carry
	// ?remote=1; every link is a route of its own.
	let remotePictures = $state(false);
	const bodyUrl = $derived(
		`${
			data.part === null
				? resolve('/messages/[id]/body', { id: message.id })
				: resolve('/messages/[id]/forwarded/[part]/body', {
						id: message.id,
						part: String(data.part)
					})
		}${remotePictures ? '?remote=1' : ''}`
	);

	/** An attachment shown in the browser (a picture, a HEIC photo's JPEG copy, a PDF). */
	function pictureUrl(index: number): ResolvedPathname {
		return data.part === null
			? resolve('/messages/[id]/attachments/[index]/open', {
					id: message.id,
					index: String(index)
				})
			: resolve('/messages/[id]/forwarded/[part]/attachments/[index]/open', {
					id: message.id,
					part: String(data.part),
					index: String(index)
				});
	}

	/** Attachments shown, without the small pictures a body shows itself (logos, pasted images). */
	const attachments = $derived(
		(view?.attachments ?? []).filter(
			(attachment) =>
				!(attachment.inline && attachment.preview === 'image' && attachment.bytes < 30_000)
		)
	);
	const pictures = $derived(attachments.filter((attachment) => attachment.preview === 'image'));
	const others = $derived(attachments.filter((attachment) => attachment.preview !== 'image'));

	/** The original file, downloaded. */
	function downloadUrl(index: number): ResolvedPathname {
		return data.part === null
			? resolve('/messages/[id]/attachments/[index]', { id: message.id, index: String(index) })
			: resolve('/messages/[id]/forwarded/[part]/attachments/[index]', {
					id: message.id,
					part: String(data.part),
					index: String(index)
				});
	}

	// The lightbox (ui/lightbox.svelte): the pictures, then the PDFs, flicked through in order.
	const viewable = $derived([
		...pictures,
		...others.filter((attachment) => attachment.preview === 'pdf')
	]);
	const lightboxItems = $derived(
		viewable.map((attachment): LightboxItem => ({
			kind: attachment.preview === 'pdf' ? 'pdf' : 'image',
			view: pictureUrl(attachment.index),
			download: downloadUrl(attachment.index),
			filename: attachment.filename,
			caption: formatBytes(attachment.bytes)
		}))
	);
	let showing = $state<number | null>(null);

	/** A plain click opens the lightbox; Ctrl, Shift or a middle click still opens a tab. */
	function openInLightbox(event: MouseEvent, attachmentIndex: number): void {
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
			return;
		}
		const position = viewable.findIndex((attachment) => attachment.index === attachmentIndex);
		if (position < 0) return;
		event.preventDefault();
		showing = position;
	}

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
			case 'archived':
				return `Moved to the online archive by the archive policy (from ${event.fromFolderPath ?? '?'} to ${event.toFolderPath ?? '?'}). Both copies are kept.`;
		}
	}
</script>

<p class="small"><a href={resolve('/search')}>Search</a></p>

<PageHeader
	title={message.subject === '' ? (archive ? 'Archive item' : '(no subject)') : message.subject}
	lede={`${message.mailboxAddress}${archive ? ' (online archive)' : ''} · ${message.folderPath}`}
>
	{#snippet actions()}
		{#if archive}
			<Button href={resolve('/messages/[id]/eml', { id: message.id })}>Download .eml</Button>
			<Button variant="secondary" href={resolve('/messages/[id]/download', { id: message.id })}
				>Download the original (.fts)</Button
			>
		{:else}
			<Button href={resolve('/messages/[id]/download', { id: message.id })}>Download .eml</Button>
		{/if}
	{/snippet}
</PageHeader>

<Card title={data.part === null ? 'Message' : 'Forwarded email inside this message'}>
	{#if data.part !== null}
		<p class="small">
			<a href={resolve('/messages/[id]', { id: message.id })}>Back to the message itself</a>
		</p>
	{/if}
	{#if view === null}
		<p class="muted">
			This message cannot be shown here: {data.viewProblem ?? 'it could not be read'}. Its download
			still works.
		</p>
	{:else}
		<DetailView>
			<dt>From</dt>
			<dd>{view.from === '' ? '—' : view.from}</dd>
			<dt>To</dt>
			<dd>{view.to === '' ? '—' : view.to}</dd>
			{#if view.cc !== ''}
				<dt>Cc</dt>
				<dd>{view.cc}</dd>
			{/if}
			<dt>Date</dt>
			<dd title={view.date === '' ? undefined : `As written: ${view.date}`}>
				{#if view.sentAt !== null}{formatDateTime(
						view.sentAt,
						true
					)}{:else if view.date === ''}—{:else}{view.date}{/if}
			</dd>
			<dt>Subject</dt>
			<dd>{view.subject === '' ? '(no subject)' : view.subject}</dd>
		</DetailView>
		<div class="body-bar">
			<span class="muted small">
				{#if remotePictures}
					Pictures from the internet are shown.
				{:else}
					Pictures from the internet are blocked, so opening this does not tell the sender.
				{/if}
			</span>
			<Button size="sm" variant="secondary" onclick={() => (remotePictures = !remotePictures)}
				>{remotePictures ? 'Block them again' : 'Show them'}</Button
			>
		</div>
		<iframe
			class="body"
			title="Message body"
			src={bodyUrl}
			sandbox="allow-popups allow-popups-to-escape-sandbox"
			referrerpolicy="no-referrer"
		></iframe>
		{#if pictures.length > 0}
			<h3>Pictures</h3>
			<div class="pictures">
				{#each pictures as picture (picture.index)}
					<a
						class="picture"
						href={data.part === null
							? resolve('/messages/[id]/attachments/[index]/open', {
									id: message.id,
									index: String(picture.index)
								})
							: resolve('/messages/[id]/forwarded/[part]/attachments/[index]/open', {
									id: message.id,
									part: String(data.part),
									index: String(picture.index)
								})}
						target="_blank"
						rel="noopener noreferrer"
						onclick={(event) => {
							openInLightbox(event, picture.index);
						}}
					>
						<img src={pictureUrl(picture.index)} alt={picture.filename} loading="lazy" />
						<span class="small">{picture.filename} · {formatBytes(picture.bytes)}</span>
					</a>
				{/each}
			</div>
		{/if}
		{#if others.length > 0}
			<h3>Attachments</h3>
			<ul class="attachments">
				{#each others as attachment (attachment.index)}
					<li>
						<span>
							{attachment.filename}
							<span class="muted small"
								>{attachment.contentType} · {formatBytes(
									attachment.bytes
								)}{attachment.insideAttachment !== null ? ' · inside a forwarded email' : ''}</span
							>
						</span>
						<span class="actions">
							{#if attachment.preview === 'email' && data.part === null}
								<a
									href={resolve('/messages/[id]/forwarded/[part]', {
										id: message.id,
										part: String(attachment.index)
									})}>View</a
								>
							{:else if attachment.preview === 'pdf' || attachment.preview === 'text'}
								<a
									href={data.part === null
										? resolve('/messages/[id]/attachments/[index]/open', {
												id: message.id,
												index: String(attachment.index)
											})
										: resolve('/messages/[id]/forwarded/[part]/attachments/[index]/open', {
												id: message.id,
												part: String(data.part),
												index: String(attachment.index)
											})}
									target="_blank"
									rel="noopener noreferrer"
									onclick={(event) => {
										if (attachment.preview === 'pdf') openInLightbox(event, attachment.index);
									}}>Open</a
								>
							{/if}
							<a
								href={data.part === null
									? resolve('/messages/[id]/attachments/[index]', {
											id: message.id,
											index: String(attachment.index)
										})
									: resolve('/messages/[id]/forwarded/[part]/attachments/[index]', {
											id: message.id,
											part: String(data.part),
											index: String(attachment.index)
										})}>Download</a
							>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</Card>

<Lightbox items={lightboxItems} bind:index={showing} />

<Card title="Where it is">
	<DetailView>
		{#if message.deletedAt !== null}
			<dt>State</dt>
			<dd>
				<Badge tone="warn">Deleted in Microsoft 365</Badge>
				{formatDateTime(message.deletedAt)}. The stored copy is kept.
			</dd>
		{:else if message.leftAt !== null && message.otherCopy !== null}
			<dt>State</dt>
			<dd>
				<Badge tone="info">Moved to the online archive</Badge>
				{formatDateTime(message.leftAt)}.
			</dd>
		{:else if message.leftAt !== null}
			<dt>State</dt>
			<dd>
				<Badge tone="warn">Left the mailbox</Badge>
				{formatDateTime(message.leftAt)}. Lookstow is looking for it in the online archive; if it is
				not there within a week, it was deleted.
			</dd>
		{/if}
		{#if message.otherCopy !== null}
			<dt>
				{message.otherCopy.mailboxKind === 'archive'
					? 'Also in the online archive'
					: 'Also in the mailbox'}
			</dt>
			<dd>
				<a href={resolve('/messages/[id]', { id: message.otherCopy.id })}
					>{message.otherCopy.folderPath}</a
				>
				({message.otherCopy.mailboxAddress})
			</dd>
		{/if}
		<dt>From</dt>
		<dd>{message.sender === '' ? '—' : message.sender}</dd>
		<dt>To and Cc</dt>
		<dd>{message.recipients === '' ? 'Not recorded' : message.recipients}</dd>
		<dt>Received</dt>
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
				Exchange's full-fidelity export (<code>.fts</code>), kept exactly as Microsoft gave it.
				Download .eml makes a copy any mail program opens, with the body, attachments and attached
				messages.
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
	</DetailView>
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
	.body-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin: var(--space-4) 0 var(--space-2);
	}

	.body {
		width: 100%;
		height: 60vh;
		min-height: 20rem;
		resize: vertical;
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-md);
		background: var(--colour-email-paper);
	}

	.pictures {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
		gap: var(--space-3);
	}

	.picture {
		display: grid;
		gap: var(--space-1);
		color: inherit;
		text-decoration: none;
	}

	.picture img {
		width: 100%;
		height: 10rem;
		object-fit: cover;
		border-radius: var(--radius-md);
		border: 1px solid var(--colour-border);
	}

	.attachments {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}

	.attachments li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.actions {
		display: flex;
		gap: var(--space-3);
	}

	.history {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}
</style>
