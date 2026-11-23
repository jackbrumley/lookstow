<!--
	RecordModals: one record's View window and Edit window, the flow every list follows (a table
	row, then View, then Edit), from Midfield Digital Labs. View shows the details, with Edit,
	any other buttons, and Delete (which asks first) in its footer. Edit holds the form; saving
	returns to View, and closing it with unsaved changes asks first.

	<RecordModals record={open} onclose={() => (open = null)} title={(a) => a.name}
		editAction="?/edit" deleteAction="?/remove" deleteFields={(a) => ({ id: a.id })}
		deleteQuestion={(a) => ({ title: `Remove ${a.name}?`, message: '…', confirmText: 'Remove' })}>
		{#snippet details(a)}<DetailView>…</DetailView>{/snippet}
		{#snippet form(a)}<input type="hidden" name="id" value={a.id} />…{/snippet}
	</RecordModals>

	Pass `record` as the record as it stands now (looked up again from the page's data), so View
	shows each change once the page has reloaded.
-->
<script lang="ts" generics="T extends object">
	import type { Snippet } from 'svelte';
	import Button from './button.svelte';
	import ConfirmForm from './confirm-form.svelte';
	import FormModal from './form-modal.svelte';
	import Modal from './modal.svelte';
	import type { Question } from '#lib/runes/confirm.svelte.ts';

	interface Props {
		/** The record open, or null when both windows are closed. */
		record: T | null;
		onclose: () => void;
		/** View's title. */
		title: (record: T) => string;
		details: Snippet<[T]>;
		/** More buttons for View's footer, after Edit. */
		actions?: Snippet<[T]> | undefined;
		size?: 'md' | 'lg';
		/** The Edit window's action; no Edit button without it. */
		editAction?: string | undefined;
		/** Default "Edit". */
		editLabel?: string;
		/** Default "Edit: " and View's title. */
		editTitle?: ((record: T) => string) | undefined;
		/** The Edit window's fields, with the record's key as a hidden field. */
		form?: Snippet<[T]> | undefined;
		/** After a save, back in View. */
		onsaved?: (() => void) | undefined;
		/** The Delete action; no Delete button without it. */
		deleteAction?: string | undefined;
		/** Default "Delete…". */
		deleteLabel?: string;
		deleteFields?: ((record: T) => Record<string, string>) | undefined;
		deleteQuestion?: ((record: T) => Question) | undefined;
	}

	let {
		record,
		onclose,
		title,
		details,
		actions,
		size = 'md',
		editAction,
		editLabel = 'Edit',
		editTitle,
		form,
		onsaved,
		deleteAction,
		deleteLabel = 'Delete…',
		deleteFields,
		deleteQuestion
	}: Props = $props();

	let editing = $state(false);

	// A record that goes (deleted, or gone from the page) closes both windows.
	$effect(() => {
		if (record === null) editing = false;
	});
</script>

{#if record !== null}
	{@const current = record}
	<Modal open={!editing} title={title(current)} {size} {onclose}>
		{@render details(current)}
		{#snippet footer()}
			<div class="footer">
				<div class="left">
					{#if editAction !== undefined && form !== undefined}
						<Button onclick={() => (editing = true)}>{editLabel}</Button>
					{/if}
					{@render actions?.(current)}
				</div>
				{#if deleteAction !== undefined && deleteQuestion !== undefined}
					<ConfirmForm
						action={deleteAction}
						fields={deleteFields?.(current) ?? {}}
						question={{ confirmText: 'Delete', tone: 'danger', ...deleteQuestion(current) }}
						variant="danger"
						onsuccess={onclose}>{deleteLabel}</ConfirmForm
					>
				{/if}
			</div>
		{/snippet}
	</Modal>

	{#if editAction !== undefined && form !== undefined}
		<FormModal
			bind:open={editing}
			title={editTitle?.(current) ?? `Edit: ${title(current)}`}
			action={editAction}
			{size}
			onsuccess={onsaved}
		>
			{@render form(current)}
		</FormModal>
	{/if}
{/if}

<style>
	.footer {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.left {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
