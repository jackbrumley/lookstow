<!--
	ExistingBackupChoice: inside a form that stops backing up a mailbox, asks what happens to the
	backup already made. Keeping it is the default; deleting it needs the address typed. Posts
	`existing` (keep | delete) and `confirm`.
-->
<script lang="ts">
	import { formatBytes, plural } from '#lib/utils/format.ts';

	interface Props {
		address: string;
		itemCount: number;
		byteCount: number;
	}

	let { address, itemCount, byteCount }: Props = $props();

	let existing = $state<'keep' | 'delete'>('keep');
</script>

{#if itemCount > 0}
	<fieldset>
		<legend>Its backup so far: {plural(itemCount, 'message')} ({formatBytes(byteCount)})</legend>
		<label class="choice"
			><input type="radio" name="existing" value="keep" bind:group={existing} /> Keep it (it can be backed
			up again later and carries on from there)</label
		>
		<label class="choice"
			><input type="radio" name="existing" value="delete" bind:group={existing} /> Delete it from the
			backup drive</label
		>
		{#if existing === 'delete'}
			<label class="confirm">
				Type <strong>{address}</strong> to confirm. The files cannot be brought back.
				<input name="confirm" autocomplete="off" required />
			</label>
		{/if}
	</fieldset>
{:else}
	<input type="hidden" name="existing" value="keep" />
{/if}

<style>
	fieldset {
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-md);
		padding: var(--space-3) var(--space-4);
		display: grid;
		gap: var(--space-2);
	}

	legend {
		font-weight: var(--font-weight-medium);
		padding: 0 var(--space-1);
	}

	.choice {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		font-weight: var(--font-weight-normal);
	}

	.confirm {
		display: grid;
		gap: var(--space-1);
		color: var(--colour-bad-text);
	}
</style>
