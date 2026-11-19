<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatBytes, formatCount, formatDateTime } from '#lib/utils/format.ts';

	let { data }: PageProps = $props();

	const query = $derived(data.query);
	const pageCount = $derived(
		data.total === null ? 0 : Math.max(1, Math.ceil(data.total / data.pageSize))
	);
</script>

<PageHeader
	title="Search"
	lede="Find stored messages by sender, recipient, subject, folder, Message-ID or date."
/>

<Card>
	<form method="GET" class="search">
		<label class="wide">
			Mailbox
			<input
				type="search"
				name="mailbox"
				list="search-mailboxes"
				value={data.mailboxText}
				placeholder="Every mailbox: type to pick one"
				autocomplete="off"
			/>
			<datalist id="search-mailboxes">
				{#each data.mailboxes as label (label)}
					<option value={label}></option>
				{/each}
			</datalist>
		</label>
		<label class="wide">
			Words
			<input
				type="search"
				name="q"
				value={query.text}
				placeholder="In the subject, sender or recipients"
			/>
		</label>
		<label>
			From
			<input name="from" value={query.from} placeholder="Name or address" />
		</label>
		<label>
			To or Cc
			<input name="to" value={query.to} placeholder="Address" />
		</label>
		<label>
			Subject
			<input name="subject" value={query.subject} />
		</label>
		<label>
			Folder
			<input name="folder" value={query.folder} placeholder="e.g. Inbox" />
		</label>
		<label>
			Message-ID
			<input name="messageId" value={query.messageId} placeholder="<…@…>" />
		</label>
		<label>
			Received from
			<input type="date" name="after" value={query.after} />
		</label>
		<label>
			Received to
			<input type="date" name="before" value={query.before} />
		</label>
		<label class="check">
			<input type="checkbox" name="deleted" checked={query.includeDeleted} />
			Include messages deleted in Microsoft 365
		</label>
		<div class="buttons">
			<Button type="submit">Search</Button>
			<Button variant="ghost" href={resolve('/search')}>Clear</Button>
		</div>

		{#if data.total !== null && pageCount > 1}
			<nav class="pages" aria-label="Pages">
				<button type="submit" name="page" value={data.page - 1} disabled={data.page === 0}
					>Previous</button
				>
				<span>Page {data.page + 1} of {formatCount(pageCount)}</span>
				<button
					type="submit"
					name="page"
					value={data.page + 1}
					disabled={data.page >= pageCount - 1}>Next</button
				>
			</nav>
		{/if}
	</form>
	<p class="muted small">
		Words match anywhere in the subject, sender and recipients, without regard to case. Message
		bodies are not searched. Recipients are recorded for messages stored from version 0.4 on, and
		for every online archive item.
	</p>
</Card>

{#if data.unknownMailbox}
	<Card tone="warn">
		<p>No mailbox is called “{data.mailboxText}”. Type a few letters and pick one from the list.</p>
	</Card>
{/if}

{#if data.total !== null}
	<Card title={`${formatCount(data.total)} ${data.total === 1 ? 'message' : 'messages'}`}>
		{#if data.searchingArchive}
			<p class="muted small">
				This is an online archive: its items are stored as Exchange's full-fidelity exports (.fts),
				and each downloads as an .eml from its page.
			</p>
		{/if}
		{#if data.hits.length === 0}
			<p class="muted">Nothing matches.</p>
		{:else}
			<div class="scroll">
				<table>
					<thead>
						<tr><th>Received</th><th>Subject</th><th>From</th><th>Mailbox</th><th>Folder</th></tr>
					</thead>
					<tbody>
						{#each data.hits as hit (hit.id)}
							<tr>
								<td class="nowrap">{formatDateTime(hit.receivedAt)}</td>
								<td>
									<a href={resolve('/messages/[id]', { id: hit.id })}
										>{hit.subject === ''
											? hit.mailboxKind === 'archive'
												? 'Archive item'
												: '(no subject)'
											: hit.subject}</a
									>
									{#if hit.deletedAt !== null}<Badge tone="warn">Deleted</Badge>{/if}
									<span class="muted small">{formatBytes(hit.byteCount)}</span>
								</td>
								<td>{hit.sender}</td>
								<td>{hit.mailboxAddress}{hit.mailboxKind === 'archive' ? ' (archive)' : ''}</td>
								<td>{hit.folderPath}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</Card>
{/if}

<style>
	.search {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: var(--space-3);
		align-items: end;
		margin-bottom: var(--space-3);
	}

	.search label {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	/* A long address never pushes a field over its neighbour. */
	.search input:not([type='checkbox']) {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}

	.search .wide {
		grid-column: span 2;
	}

	.search .check {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		grid-column: 1 / -1;
	}

	.buttons {
		display: flex;
		gap: var(--space-2);
		grid-column: 1 / -1;
	}

	.pages {
		display: flex;
		gap: var(--space-3);
		align-items: center;
		justify-content: center;
		grid-column: 1 / -1;
	}

	.pages button {
		font: inherit;
		color: var(--colour-text);
		background: var(--colour-surface);
		border: 1px solid var(--colour-border);
		border-radius: 999px;
		padding: var(--space-1) var(--space-4);
		cursor: pointer;
	}

	.pages button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.scroll {
		overflow-x: auto;
	}

	.nowrap {
		white-space: nowrap;
	}

	@media (max-width: 40rem) {
		.search .wide {
			grid-column: 1 / -1;
		}
	}
</style>
