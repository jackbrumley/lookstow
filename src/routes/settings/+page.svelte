<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import FormModal from '#lib/ui/form-modal.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import BackupFolderCard from './backup-folder-card.svelte';
	import RemoteAccessCard from './remote-access-card.svelte';
	import { SCHEDULE_LIMITS } from '#lib/domain/settings.ts';
	import { toastFormResult } from '#lib/utils/form-toast.ts';
	import {
		formatBytes,
		formatCount,
		formatDateTime,
		formatPercent,
		plural
	} from '#lib/utils/format.ts';

	let { data, form }: PageProps = $props();

	$effect(() => {
		toastFormResult(form);
	});

	const settings = $derived(data.settings);
	const connection = $derived(settings.connection);
	const outside = $derived(data.backupsOutsideScope);

	let idsOpen = $state(false);
	let secretOpen = $state(false);
	let certificateOpen = $state(false);
	let scopeOpen = $state(false);
	let scheduleOpen = $state(false);
	let updatesOpen = $state(false);
	let diskOpen = $state(false);
	let forgetOpen = $state(false);
	let aiOpen = $state(false);
	const ai = $derived(data.ai);
	const newToken = $derived(form !== null && 'token' in form ? form.token : null);
	const connectCommand = $derived(
		`claude mcp add --transport http lookstow http://127.0.0.1:8030/mcp --header "Authorization: Bearer ${newToken ?? '<token>'}"`
	);
	const pace = $derived(data.learnedPace);
	// The scope form's mode, reset from the saved setting each time the form opens.
	let scopeMode = $state<'all' | 'selected'>('all');
	let scopeExisting = $state<'keep' | 'delete'>('keep');
	$effect(() => {
		if (scopeOpen) {
			scopeMode = untrack(() => settings.scope.mode);
			scopeExisting = 'keep';
		}
	});
	let testing = $state(false);
</script>

<PageHeader
	title="Settings"
	lede="How Lookstow reaches Microsoft 365, what it backs up, when, and where. Changes take effect within seconds, also while syncs are running."
/>

<Card title="Microsoft 365 connection">
	{#snippet actions()}
		<Button variant="secondary" onclick={() => (idsOpen = true)}>Edit IDs…</Button>
		<form
			method="POST"
			action="?/test"
			use:enhance={() => {
				testing = true;
				return async ({ update }) => {
					await update();
					testing = false;
				};
			}}
		>
			<Button type="submit" disabled={testing || connection.auth.kind === 'none'}>
				{testing ? 'Testing…' : 'Test connection'}
			</Button>
		</form>
	{/snippet}
	<dl class="facts">
		<dt>Tenant ID</dt>
		<dd>{connection.tenantId === '' ? 'Not set' : connection.tenantId}</dd>
		<dt>Application (client) ID</dt>
		<dd>{connection.clientId === '' ? 'Not set' : connection.clientId}</dd>
		<dt>Signs in with</dt>
		<dd>
			{#if connection.auth.kind === 'certificate'}
				<Badge tone="ok">Certificate</Badge>
				thumbprint <code>{connection.auth.thumbprint}</code>, valid until
				{formatDateTime(connection.auth.validTo)}.
				<a href={resolve('/settings/certificate.cer')} download>Download the certificate</a>
			{:else if connection.auth.kind === 'secret'}
				<Badge tone="warn">Client secret</Badge>
				{connection.auth.hint}, saved {formatDateTime(connection.auth.setAt)}. A certificate is
				safer: secrets expire and can be copied.
			{:else}
				<Badge tone="bad">Nothing yet</Badge>
			{/if}
		</dd>
	</dl>
	<div class="row">
		<Button
			variant={connection.auth.kind === 'certificate' ? 'secondary' : 'primary'}
			onclick={() => (certificateOpen = true)}
		>
			{connection.auth.kind === 'certificate'
				? 'Replace the certificate…'
				: 'Create a certificate…'}
		</Button>
		<Button variant="ghost" onclick={() => (secretOpen = true)}>Use a client secret instead…</Button
		>
	</div>

	<details class="guide">
		<summary>How to register Lookstow in Microsoft Entra</summary>
		<ol>
			<li>
				In the Microsoft Entra admin centre, open <strong>App registrations</strong> and choose
				<strong>New registration</strong>. Name it <em>Lookstow</em>, single tenant, no redirect
				URI.
			</li>
			<li>
				Copy the <strong>Directory (tenant) ID</strong> and <strong>Application (client) ID</strong>
				into <em>Edit IDs</em> here.
			</li>
			<li>
				Under <strong>API permissions</strong>, add Microsoft Graph <em>application</em> permissions
				<code>User.Read.All</code>, <code>Mail.Read</code> and <code>MailboxSettings.Read</code>.
				For online archives also add <code>MailboxFolder.Read.All</code>,
				<code>MailboxItem.Read.All</code> and <code>MailboxItem.Export.All</code>. Then
				<strong>Grant admin consent</strong>.
			</li>
			<li>
				Here, choose <em>Create a certificate</em> and download it. In the app registration, under
				<strong>Certificates &amp; secrets</strong> &gt; <strong>Certificates</strong>, upload it.
			</li>
			<li>Choose <em>Test connection</em>. When every step passes, discovery starts.</li>
		</ol>
		<p class="muted small">
			<code>Mail.Read</code> as an application permission can read every mailbox in the tenant. To limit
			Lookstow to some mailboxes, use Exchange Online's RBAC for Applications instead of the Entra permission.
		</p>
	</details>
</Card>

<Card title="What is backed up">
	{#snippet actions()}
		<Button variant="secondary" onclick={() => (scopeOpen = true)}>Change…</Button>
	{/snippet}
	{#if settings.scope.mode === 'selected'}
		<p>
			<strong>Only the mailboxes you pick</strong>
			({settings.scope.selectedAddresses.length}). Pick them on the
			<a href={resolve('/mailboxes')}>Mailboxes</a> page, or list them here with Change.
		</p>
		{#if settings.scope.selectedAddresses.length > 0}
			<p class="muted small">{settings.scope.selectedAddresses.join(', ')}</p>
		{/if}
		<p class="muted small">
			Online archives of picked mailboxes: {settings.scope.includeArchives ? 'yes' : 'no'}.
			Recoverable Items: {settings.scope.includeRecoverable ? 'yes' : 'no'}.
		</p>
	{:else}
		<ul class="plain">
			<li>Every user mailbox discovery finds.</li>
			<li>Shared mailboxes: <strong>{settings.scope.includeShared ? 'yes' : 'no'}</strong></li>
			<li>
				Room and equipment mailboxes:
				<strong>{settings.scope.includeResources ? 'yes' : 'no'}</strong>
			</li>
			<li>
				Online archives: <strong>{settings.scope.includeArchives ? 'yes' : 'no'}</strong>
			</li>
			<li>
				Recoverable Items and root items:
				<strong>{settings.scope.includeRecoverable ? 'yes' : 'no'}</strong>
			</li>
			<li>
				Never backed up:
				{#if settings.scope.excludedAddresses.length === 0}
					<strong>none</strong>
				{:else}
					{settings.scope.excludedAddresses.join(', ')}
				{/if}
			</li>
		</ul>
	{/if}
	{#if outside.mailboxes > 0}
		<p>
			<strong>{plural(outside.mailboxes, 'mailbox', 'mailboxes')} that are not backed up</strong>
			still have backups on the drive ({formatBytes(outside.bytes)}). To delete them, use Change and
			choose Delete.
		</p>
	{/if}
	<p class="muted small">
		Picking limits what Lookstow copies. To limit what it can read at all, scope the app with
		Exchange Online RBAC for Applications.
	</p>
</Card>

<Card title="Schedule">
	{#snippet actions()}
		<Button variant="secondary" onclick={() => (scheduleOpen = true)}>Change…</Button>
	{/snippet}
	{#if settings.schedule.paused}<p>
			<Badge tone="warn">Paused</Badge> Nothing syncs until someone presses Resume at the top of the page.
		</p>{/if}
	<ul class="plain">
		<li>
			Every mailbox is synced every <strong>{settings.schedule.syncEveryMinutes} minutes</strong>.
		</li>
		<li>
			New and removed mailboxes are looked for every <strong
				>{settings.schedule.discoverEveryHours} hours</strong
			>.
		</li>
		<li>
			<strong>{settings.schedule.parallelMailboxes}</strong> mailboxes at most are synced at the same
			time; Lookstow adds them while Microsoft has room, and uses fewer while it asks Lookstow to slow
			down.
		</li>
	</ul>
</Card>

<Card title="Speed">
	{#snippet actions()}
		<Button variant="secondary" onclick={() => (forgetOpen = true)}>Forget what was learned…</Button
		>
	{/snippet}
	<p>
		Lookstow finds how fast Microsoft lets it copy, holds just under that, and keeps what it learned
		across restarts. Now: <strong>{pace.startsPerSecond.toFixed(1)} requests a second</strong>, at
		most
		<strong>{pace.inFlightCap}</strong> at once.
	</p>
	<p class="muted small">
		{#if pace.ceiling === null}
			Microsoft has not asked Lookstow to slow down yet.
		{:else}
			Microsoft last asked it to slow down at {pace.ceiling.startsPerSecond.toFixed(1)} requests a second,
			{formatDateTime(new Date(pace.ceiling.at).toISOString())}.
		{/if}
		Mailboxes are added while Microsoft has room for them, up to the schedule's maximum.
	</p>
</Card>

<FormModal
	bind:open={forgetOpen}
	title="Forget what was learned?"
	action="?/forgetPace"
	submitLabel="Forget"
>
	<p>
		Lookstow goes back to its first-run pace and finds Microsoft’s limit again over the next hour or
		so. Use this after Microsoft’s limits change, or if copying stays slow for no clear reason.
	</p>
</FormModal>

<Card title="AI tools">
	{#snippet actions()}
		<Button variant="secondary" onclick={() => (aiOpen = true)}>Change…</Button>
	{/snippet}
	<p>
		{#if ai.enabled}
			<Badge tone="ok">On</Badge> An AI agent on this computer (such as Claude Code) can search the backup,
			read messages and look at attachments through <code>http://127.0.0.1:8030/mcp</code>, with the
			access token. It cannot change anything.
		{:else}
			<Badge tone="neutral">Off</Badge> No AI agent can read the backup.
		{/if}
	</p>
	<p class="muted small">
		{#if ai.tokenHint === null}
			No access token yet.
		{:else}
			Access token ending …{ai.tokenHint}, created {formatDateTime(ai.tokenCreatedAt ?? '')}.
		{/if}
		Every message and attachment an agent opens is written to the ai-audit folder in the data folder.
	</p>
	<p>
		Content index: {formatCount(data.contentIndex.indexed)} of {formatCount(
			data.contentIndex.total
		)}
		messages read ({formatPercent(
			data.contentIndex.total === 0
				? 100
				: (data.contentIndex.indexed / data.contentIndex.total) * 100
		)}). Searches by words in the message, photos, PDFs and attachments find only messages it has
		read; the rest are read in the background while AI tools are on.
	</p>
	{#if data.indexing !== null}
		<p class="muted small">{data.indexing}</p>
	{/if}
	{#if newToken !== null}
		<p><strong>New access token (shown once):</strong></p>
		<pre class="token">{newToken}</pre>
		<p class="muted small">Add Lookstow to Claude Code on this computer:</p>
		<pre class="token">{connectCommand}</pre>
	{/if}
	<form method="POST" action="?/aiToken" use:enhance>
		<Button variant="secondary" type="submit"
			>{ai.tokenHint === null ? 'Create access token' : 'Replace access token'}</Button
		>
	</form>
</Card>

<FormModal bind:open={aiOpen} title="AI tools" action="?/aiEnabled">
	<label class="check">
		<input type="checkbox" name="enabled" checked={ai.enabled} />
		Let AI agents on this computer read the backup (with the access token)
	</label>
	<p class="muted small">
		They can search, read messages and download attachments. They cannot change, delete or send
		anything.
	</p>
</FormModal>

<RemoteAccessCard
	remote={data.remote}
	credentials={form !== null && 'credentials' in form ? form.credentials : null}
/>

<BackupFolderCard
	root={settings.backup.root}
	effectiveRoot={settings.backup.effectiveRoot}
	storedFiles={data.storedFiles}
	move={data.live.engine.backupMove}
	snapshots={data.indexSnapshots}
/>

<Card title="Updates">
	{#snippet actions()}
		<Button variant="secondary" onclick={() => (updatesOpen = true)}>Change…</Button>
	{/snippet}
	<p>
		{settings.updates.automatic
			? 'New releases are installed automatically, soon after the daily check finds one.'
			: 'New releases wait for someone to choose Update now on the Updates page.'}
	</p>
</Card>

<Card title="Disk space">
	{#snippet actions()}
		<Button variant="secondary" onclick={() => (diskOpen = true)}>Change…</Button>
	{/snippet}
	<p>
		Lookstow warns when the backup drive is <strong>{settings.disk.warnPercent}%</strong> full and
		pauses every sync at <strong>{settings.disk.pausePercent}%</strong>, so the drive never fills.
	</p>
</Card>

<FormModal bind:open={diskOpen} title="Disk space" action="?/disk">
	<label>
		Warn when the backup drive is this full (%)
		<input
			name="warnPercent"
			type="number"
			min="50"
			max="98"
			value={settings.disk.warnPercent}
			required
		/>
	</label>
	<label>
		Pause every sync when it is this full (%)
		<input
			name="pausePercent"
			type="number"
			min="51"
			max="99"
			value={settings.disk.pausePercent}
			required
		/>
	</label>
</FormModal>

<FormModal bind:open={updatesOpen} title="Updates" action="?/updates">
	<label class="check"
		><input type="checkbox" name="automatic" checked={settings.updates.automatic} /> Install new releases
		automatically</label
	>
	<p class="muted small">
		Every release is signed and checked before it is installed. If a new version does not start, the
		updater puts the previous one back.
	</p>
</FormModal>

<FormModal bind:open={idsOpen} title="Microsoft 365 tenant and app" action="?/connection">
	<label
		>Directory (tenant) ID <input
			name="tenantId"
			value={connection.tenantId}
			required
			autocomplete="off"
		/></label
	>
	<label
		>Application (client) ID <input
			name="clientId"
			value={connection.clientId}
			required
			autocomplete="off"
		/></label
	>
</FormModal>

<FormModal
	bind:open={certificateOpen}
	title="Create a sign-in certificate"
	action="?/certificate"
	submitLabel="Create"
>
	<p>
		Lookstow makes a new certificate and keeps its private key, sealed, on this server. Download the
		certificate afterwards and upload it to the app registration.
	</p>
	{#if connection.auth.kind !== 'none'}
		<p>
			<strong>This replaces how Lookstow signs in now.</strong> Backups stop until the new certificate
			is uploaded.
		</p>
	{/if}
</FormModal>

<FormModal bind:open={secretOpen} title="Use a client secret" action="?/secret">
	<p class="muted small">
		Paste the secret's <em>Value</em> from Certificates &amp; secrets, not its ID. It is sealed before
		it is stored.
	</p>
	<label>Client secret <input name="secret" type="password" required autocomplete="off" /></label>
</FormModal>

<FormModal bind:open={scopeOpen} title="What is backed up" action="?/scope">
	<fieldset class="choice">
		<legend>Back up</legend>
		<label class="check"
			><input type="radio" name="mode" value="all" bind:group={scopeMode} /> Every mailbox discovery finds</label
		>
		<label class="check"
			><input type="radio" name="mode" value="selected" bind:group={scopeMode} /> Only the mailboxes I
			pick</label
		>
	</fieldset>
	{#if scopeMode === 'selected'}
		<label>
			Mailboxes to back up (one address per line)
			<textarea name="selected" rows="5">{settings.scope.selectedAddresses.join('\n')}</textarea>
		</label>
	{:else}
		<input type="hidden" name="selected" value={settings.scope.selectedAddresses.join('\n')} />
	{/if}
	<label class="check"
		><input type="checkbox" name="includeShared" checked={settings.scope.includeShared} /> Shared mailboxes</label
	>
	<label class="check"
		><input type="checkbox" name="includeResources" checked={settings.scope.includeResources} /> Room
		and equipment mailboxes</label
	>
	<label class="check"
		><input type="checkbox" name="includeArchives" checked={settings.scope.includeArchives} /> Online
		archives</label
	>
	<label class="check"
		><input type="checkbox" name="includeRecoverable" checked={settings.scope.includeRecoverable} /> Recoverable
		Items and root items: deleted items Microsoft keeps for a hold (deletions, purges, earlier versions),
		and items in a mailbox's or archive's top folder. Where Microsoft refuses them for a mailbox, the
		Log says so and the rest syncs as usual.</label
	>
	<label>
		Never back up these addresses (one per line)
		<textarea name="excluded" rows="5">{settings.scope.excludedAddresses.join('\n')}</textarea>
	</label>
	<fieldset class="choice">
		<legend>Backups of mailboxes that are not backed up</legend>
		<label class="check"
			><input type="radio" name="existing" value="keep" bind:group={scopeExisting} /> Keep them</label
		>
		<label class="check"
			><input type="radio" name="existing" value="delete" bind:group={scopeExisting} /> Delete them from
			the backup drive</label
		>
		{#if scopeExisting === 'delete'}
			<p class="muted small">
				Deletes the backup of every mailbox that is not backed up once you save: those this change
				leaves out, those left out before ({plural(outside.mailboxes, 'mailbox', 'mailboxes')} now,
				{formatBytes(outside.bytes)}), and mailboxes gone from Microsoft 365 that are not backed up.
			</p>
			<label>
				Type DELETE to confirm. The files cannot be brought back.
				<input name="confirm" autocomplete="off" required />
			</label>
		{/if}
	</fieldset>
</FormModal>

<FormModal bind:open={scheduleOpen} title="Schedule" action="?/schedule">
	<label>
		Sync every mailbox every (minutes)
		<input
			name="syncEveryMinutes"
			type="number"
			min={SCHEDULE_LIMITS.syncEveryMinutes.min}
			max={SCHEDULE_LIMITS.syncEveryMinutes.max}
			value={settings.schedule.syncEveryMinutes}
			required
		/>
	</label>
	<label>
		Look for new mailboxes every (hours)
		<input
			name="discoverEveryHours"
			type="number"
			min={SCHEDULE_LIMITS.discoverEveryHours.min}
			max={SCHEDULE_LIMITS.discoverEveryHours.max}
			value={settings.schedule.discoverEveryHours}
			required
		/>
	</label>
	<label>
		At most this many mailboxes at the same time
		<input
			name="parallelMailboxes"
			type="number"
			min={SCHEDULE_LIMITS.parallelMailboxes.min}
			max={SCHEDULE_LIMITS.parallelMailboxes.max}
			value={settings.schedule.parallelMailboxes}
			required
		/>
	</label>
</FormModal>

<style>
	.facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-2) var(--space-4);
		margin: 0 0 var(--space-4);
	}

	.facts dt {
		color: var(--colour-text-muted);
	}

	.facts dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.guide {
		margin-top: var(--space-4);
	}

	.guide summary {
		cursor: pointer;
		font-weight: var(--font-weight-medium);
	}

	.guide ol {
		display: grid;
		gap: var(--space-2);
	}

	.plain {
		margin: 0;
		padding-left: var(--space-5);
		display: grid;
		gap: var(--space-1);
	}

	label {
		display: grid;
		gap: var(--space-1);
	}

	.choice {
		border: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}

	.choice legend {
		font-weight: var(--font-weight-medium);
		margin-bottom: var(--space-1);
	}

	label.check {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.token {
		white-space: pre-wrap;
		word-break: break-all;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		background: var(--colour-surface-alt);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
	}

	form {
		display: contents;
	}
</style>
