<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';
	import DetailView from '#lib/ui/detail-view.svelte';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import DataTable from '#lib/ui/data-table.svelte';
	import FormModal from '#lib/ui/form-modal.svelte';
	import ConfirmForm from '#lib/ui/confirm-form.svelte';
	import RecordModals from '#lib/ui/record-modals.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import {
		ALERT_LABELS,
		ALERT_TYPES,
		type AlertRecipient,
		type EmailStatus
	} from '#lib/domain/alerts.ts';
	import { toastFormResult } from '#lib/utils/form-toast.ts';
	import { formatCount, formatDateTime } from '#lib/utils/format.ts';

	let { data, form }: PageProps = $props();

	type RowPerson = AlertRecipient;
	type RowEmail = PageProps['data']['emails'][number];

	$effect(() => {
		toastFormResult(form);
	});

	let mailgunOpen = $state(false);
	let addOpen = $state(false);
	/** The person opened from the list. */
	let chosen = $state<AlertRecipient | null>(null);
	let testing = $state<string | null>(null);

	const STATUS: Record<EmailStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' }> = {
		sent: { label: 'Sent', tone: 'ok' },
		queued: { label: 'Waiting to retry', tone: 'info' },
		failed: { label: 'Failed', tone: 'bad' },
		'not-sent': { label: 'Not sent', tone: 'warn' }
	};

	// The person opened from the list, as they stand now.
	const viewed = $derived(
		chosen === null ? undefined : data.recipients.find((each) => each.id === chosen?.id)
	);

	function open(person: AlertRecipient): void {
		chosen = person;
	}
</script>

<PageHeader
	title="Alerts"
	lede="Who gets an email when something needs attention, and every email Lookstow has sent."
/>

<Card title="Sending email">
	{#snippet actions()}
		<Button variant="secondary" onclick={() => (mailgunOpen = true)}
			>{data.mailgun.kind === 'none' ? 'Set up…' : 'Change…'}</Button
		>
		{#if data.mailgun.kind === 'set'}
			<ConfirmForm
				action="?/clearMailgun"
				variant="ghost"
				question={{
					title: 'Remove the Mailgun setup?',
					message:
						'Lookstow stops sending alert emails. Alerts are still recorded on this page, as not sent. The list of people stays.',
					confirmText: 'Remove',
					tone: 'danger'
				}}>Remove…</ConfirmForm
			>
		{/if}
	{/snippet}
	{#if data.mailgun.kind === 'none'}
		<p>
			<Badge tone="warn">Not set up</Badge> Lookstow sends alerts through Mailgun, as I12 and PT6 Control
			does. Until it is set up, alerts are recorded below as not sent.
		</p>
	{:else}
		<DetailView>
			<dt>Mailgun domain</dt>
			<dd>{data.mailgun.domain} ({data.mailgun.region === 'eu' ? 'EU' : 'US'} region)</dd>
			<dt>Sent from</dt>
			<dd>{data.mailgun.from}</dd>
			<dt>Sending key</dt>
			<dd>{data.mailgun.keyHint}, saved {formatDateTime(data.mailgun.setAt)}</dd>
		</DetailView>
	{/if}
</Card>

<Card title="Who gets alerts">
	{#snippet actions()}
		<Button onclick={() => (addOpen = true)}>Add a person…</Button>
	{/snippet}
	<DataTable
		columns={['Person', 'Alerts']}
		rows={data.recipients}
		key={(person: RowPerson) => person.id}
		label={(person: RowPerson) => person.name}
		onopen={open}
		empty="Nobody yet. Add a person and tick the alerts they need."
	>
		{#snippet first(person: RowPerson)}
			<div class="small muted">{person.email}</div>
			{#if !person.enabled}<Badge tone="warn">Paused</Badge>{/if}
		{/snippet}
		{#snippet cells(person: RowPerson)}
			<td>
				{#if person.alerts.length === 0}
					<span class="muted">None ticked</span>
				{:else}
					<ul class="alerts small">
						{#each person.alerts as alert (alert)}
							<li>{ALERT_LABELS[alert].label}</li>
						{/each}
					</ul>
				{/if}
			</td>
		{/snippet}
	</DataTable>
</Card>

<Card title="Emails">
	{#if data.emails.length > 0}
		<p class="muted small">
			The newest {formatCount(data.emails.length)} of {formatCount(data.emailCount)}. A failed send
			is tried again after 1, 5, 15 and 30 minutes, then hourly, eight tries in all.
		</p>
	{/if}
	<DataTable
		columns={['When', 'To', 'Subject', 'Result']}
		rows={data.emails}
		key={(email: RowEmail) => email.id}
		empty="No alert emails yet."
	>
		{#snippet cells(email: RowEmail)}
			<td class="nowrap">{formatDateTime(email.createdAt)}</td>
			<td
				>{email.recipient}
				<div class="small muted">{email.address}</div></td
			>
			<td>{email.subject}</td>
			<td>
				<Badge tone={STATUS[email.status].tone}>{STATUS[email.status].label}</Badge>
				{#if email.sentAt !== null}
					<div class="small muted">{formatDateTime(email.sentAt)}</div>
				{/if}
				{#if email.lastError !== null && email.status !== 'sent'}
					<div class="small error">
						{email.lastError}{email.attempts > 0 ? ` (try ${String(email.attempts)})` : ''}
					</div>
				{/if}
			</td>
		{/snippet}
	</DataTable>
</Card>

<FormModal bind:open={mailgunOpen} title="Sending email through Mailgun" action="?/mailgun">
	<p class="small muted">
		In Mailgun, open Sending &gt; Domains for the sending domain, and Domain settings &gt; Sending
		API keys for a key. The key is stored sealed and never shown again.
	</p>
	<label
		>Sending domain <input
			name="domain"
			placeholder="mg.example.com"
			required
			autocomplete="off"
			value={data.mailgun.kind === 'set' ? data.mailgun.domain : ''}
		/></label
	>
	<label
		>Region <select name="region" value={data.mailgun.kind === 'set' ? data.mailgun.region : 'us'}>
			<option value="us">US (api.mailgun.net)</option>
			<option value="eu">EU (api.eu.mailgun.net)</option>
		</select></label
	>
	<label
		>Sent from <input
			name="from"
			placeholder="Lookstow &lt;lookstow@mg.example.com&gt; (when left blank)"
			autocomplete="off"
			value={data.mailgun.kind === 'set' ? data.mailgun.from : ''}
		/></label
	>
	<label
		>Sending key <input
			name="apiKey"
			type="password"
			autocomplete="off"
			placeholder={data.mailgun.kind === 'set' ? 'Leave blank to keep the saved key' : ''}
			required={data.mailgun.kind === 'none'}
		/></label
	>
</FormModal>

{#snippet personFields(person: AlertRecipient | null)}
	<label>Name <input name="name" required maxlength="100" value={person?.name ?? ''} /></label>
	<label
		>Email address <input
			name="email"
			type="email"
			required
			autocomplete="off"
			value={person?.email ?? ''}
		/></label
	>
	<label class="check"
		><input type="checkbox" name="enabled" checked={person?.enabled ?? true} /> Send this person email</label
	>
	<fieldset>
		<legend>Alerts</legend>
		{#each ALERT_TYPES as type (type)}
			<label class="check alert-choice">
				<input
					type="checkbox"
					name={`alert-${type}`}
					checked={person === null ? type !== 'first-copy' : person.alerts.includes(type)}
				/>
				<span>
					{ALERT_LABELS[type].label}
					<span class="small muted">{ALERT_LABELS[type].description}</span>
				</span>
			</label>
		{/each}
	</fieldset>
{/snippet}

<RecordModals
	record={viewed ?? null}
	onclose={() => (chosen = null)}
	title={(person: RowPerson) => person.name}
	size="lg"
	editAction="?/edit"
	editLabel="Change…"
	editTitle={(person: RowPerson) => `Change alerts: ${person.name}`}
	deleteAction="?/remove"
	deleteLabel="Remove…"
	deleteFields={(person: RowPerson) => ({ id: person.id })}
	deleteQuestion={(person: RowPerson) => ({
		title: `Remove ${person.name}?`,
		message: `${person.name} (${person.email}) gets no more alert emails. Emails already sent stay in the list.`,
		confirmText: 'Remove'
	})}
>
	{#snippet details(person: RowPerson)}
		<DetailView>
			<dt>Email</dt>
			<dd>{person.email}</dd>
			<dt>Sending</dt>
			<dd>
				{#if person.enabled}<Badge tone="ok">On</Badge>{:else}<Badge tone="warn">Paused</Badge>{/if}
			</dd>
			<dt>Alerts</dt>
			<dd>
				{#if person.alerts.length === 0}
					<span class="muted">None ticked</span>
				{:else}
					<ul class="alerts">
						{#each person.alerts as alert (alert)}
							<li>{ALERT_LABELS[alert].label}</li>
						{/each}
					</ul>
				{/if}
			</dd>
		</DetailView>
	{/snippet}
	{#snippet actions(person: RowPerson)}
		<form
			method="POST"
			action="?/test"
			use:enhance={() => {
				testing = person.id;
				return async ({ update }) => {
					await update();
					testing = null;
				};
			}}
		>
			<input type="hidden" name="id" value={person.id} />
			<Button type="submit" variant="secondary" disabled={testing !== null}
				>{testing === person.id ? 'Sending…' : 'Send a test'}</Button
			>
		</form>
	{/snippet}
	{#snippet form(person: RowPerson)}
		<input type="hidden" name="id" value={person.id} />
		{@render personFields(person)}
	{/snippet}
</RecordModals>

<FormModal bind:open={addOpen} title="Add a person" action="?/add" submitLabel="Add" size="lg">
	{@render personFields(null)}
</FormModal>

<style>
	label {
		display: grid;
		gap: var(--space-1);
		margin-bottom: var(--space-3);
	}

	label.check {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.alert-choice span {
		display: grid;
	}

	fieldset {
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		margin: 0;
	}

	.alerts {
		margin: 0;
		padding-left: var(--space-4);
	}

	.nowrap {
		white-space: nowrap;
	}

	.error {
		color: var(--colour-bad);
	}
</style>
