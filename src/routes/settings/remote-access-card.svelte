<!--
	Settings, Remote access (docs/specs/SPEC-REMOTE.md): other computers on the network may
	search, open and download messages over HTTPS, from allowed addresses, with an account.
	Every change applies at once; every remote request is in the audit trail shown here.

	Accounts are a table: clicking one opens its window (its details, Edit, New password, New AI
	token, Delete); Edit holds its switches. Details to send someone (a password, an AI token)
	show once, in a window of their own, never inline.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Callout from '#lib/ui/callout.svelte';
	import DetailView from '#lib/ui/detail-view.svelte';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import DataTable from '#lib/ui/data-table.svelte';
	import FormModal from '#lib/ui/form-modal.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import Switch from '#lib/ui/switch.svelte';
	import { formatDateTime } from '#lib/utils/format.ts';
	import type { RemoteView } from '#lib/domain/remote.ts';
	import { toast } from '#lib/runes/toast.svelte.ts';

	interface Props {
		remote: RemoteView;
		/** An account just added or given a new password: shown once, to copy and send. */
		credentials: { username: string; password: string | null } | null;
		/** An account just given an AI token: the setup for its computer, shown once. */
		aiSetup: { username: string; token: string | null } | null;
	}

	let { remote, credentials, aiSetup }: Props = $props();

	type Account = RemoteView['accounts'][number];
	/** An audit line, numbered for the table (lines have no id of their own). */
	type AuditRow = { n: string; line: RemoteView['audit'][number] };

	let accessOpen = $state(false);
	let addOpen = $state(false);
	let certificateOpen = $state(false);
	let viewOpen = $state(false);
	let editOpen = $state(false);
	let passwordOpen = $state(false);
	let deleteOpen = $state(false);
	let viewing = $state<string | null>(null);
	// Lookstow makes the password unless someone wants to type their own.
	let makeForAdd = $state(true);
	let makeForNew = $state(true);

	/** The open account as it stands now (the page reloads after each change). */
	const account = $derived(remote.accounts.find((each) => each.username === viewing));
	const auditRows = $derived(
		remote.audit.map((line, index): AuditRow => ({ n: String(index), line }))
	);
	const activeAccounts = $derived(remote.accounts.filter((each) => !each.disabled).length);

	function open(row: Account): void {
		viewing = row.username;
		viewOpen = true;
	}

	// The details to send, until the window is closed; each new set shows again.
	let dismissed = $state<unknown>(null);
	const aiShowing = $derived(
		aiSetup !== null && aiSetup.token !== null && dismissed !== aiSetup
			? { username: aiSetup.username, token: aiSetup.token }
			: null
	);
	const showing = $derived(
		aiShowing === null && credentials !== null && dismissed !== credentials ? credentials : null
	);
	const sendTo = $derived(aiShowing?.username ?? showing?.username ?? null);
	const message = $derived.by(() => {
		if (aiShowing !== null) {
			// For Claude Code on the person's Windows computer, in Command Prompt.
			return [
				`Lookstow AI tools for ${aiShowing.username}: read-only access to the mail backup for Claude Code on your computer.`,
				'Run these once, in Command Prompt:',
				'',
				"1. Save Lookstow's certificate, so Claude Code trusts its address:",
				`   curl.exe -k -o "%USERPROFILE%\\lookstow.pem" ${remote.address}lookstow-certificate.pem`,
				'2. Tell Claude Code to trust it, then open a new Command Prompt:',
				'   setx NODE_EXTRA_CA_CERTS "%USERPROFILE%\\lookstow.pem"',
				'3. Add Lookstow to Claude Code:',
				`   claude mcp add --transport http lookstow ${remote.address}mcp --header "Authorization: Bearer ${aiShowing.token}"`,
				'',
				...(remote.fingerprint === null
					? []
					: [`The certificate's SHA-256 fingerprint is ${remote.fingerprint}.`]),
				`Keep the token private: anyone with it reads the backup as ${aiShowing.username}, from an allowed computer.`
			].join('\n');
		}
		if (showing === null) return '';
		return [
			`Lookstow (read-only access to the mail backup): ${remote.address}`,
			`Username: ${showing.username}`,
			`Password: ${showing.password ?? '(the one you were given)'}`,
			remote.fingerprint === null
				? 'Your browser warns about the certificate the first time; accept it to go on.'
				: `Your browser warns about the certificate the first time. Its SHA-256 fingerprint is ${remote.fingerprint}.`
		].join('\n');
	});
	let copied = $state(false);
	let box = $state<HTMLTextAreaElement | null>(null);

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(message);
			copied = true;
			setTimeout(() => (copied = false), 2_000);
		} catch {
			// No clipboard here: select it, so Ctrl+C copies it.
			box?.select();
			toast.error('Could not copy by itself: the text is selected, press Ctrl+C.');
		}
	}

	function sent(): void {
		dismissed = aiShowing === null ? credentials : aiSetup;
	}
</script>

<Card title="Remote access" tone={remote.problem === null ? 'plain' : 'warn'}>
	{#snippet actions()}
		<Button variant={remote.enabled ? 'secondary' : 'primary'} onclick={() => (accessOpen = true)}
			>{remote.enabled ? 'Change…' : 'Turn on…'}</Button
		>
	{/snippet}
	<div class="status" class:on={remote.enabled}>
		<span class="state">{remote.enabled ? 'On' : 'Off'}</span>
		<p>
			{#if remote.enabled}
				People with an account can search, open and download messages from the allowed computers at <code
					>{remote.address}</code
				>. They cannot change anything.
			{:else}
				Lookstow answers only on this computer. Turn this on to let others on the network search and
				read the backup, signed in and read-only.
			{/if}
		</p>
	</div>
	{#if remote.problem !== null}
		<Callout tone="danger">{remote.problem}</Callout>
	{/if}
	{#if remote.enabled && remote.allowList.length === 0}
		<Callout tone="warning">
			No computer is allowed to connect yet, so every one is refused. Add addresses with Change….
		</Callout>
	{/if}
	<p class="muted small">
		Allowed: {remote.allowList.length === 0 ? 'nobody yet' : remote.allowList.join(', ')}. Port
		{remote.port}. The certificate is self-signed: each browser warns once until the person accepts
		it.
		{#if remote.fingerprint !== null}
			Check its SHA-256 fingerprint matches <code class="fingerprint">{remote.fingerprint}</code>.
		{/if}
	</p>

	<div class="heading">
		<h3>Accounts</h3>
		<Button size="sm" variant="secondary" onclick={() => (addOpen = true)}>Add account…</Button>
	</div>
	{#if !remote.enabled && remote.accounts.length > 0}
		<Callout tone="warning">
			Remote access is off, so none of these accounts can sign in until it is turned on.
		</Callout>
	{:else if remote.enabled && activeAccounts === 0}
		<Callout tone="warning">Nobody can sign in yet: add an account, or turn one back on.</Callout>
	{/if}
	<DataTable
		columns={['Username', 'Status', 'Evidence packs', 'AI tools', 'Last signed in']}
		rows={remote.accounts}
		key={(row: Account) => row.username}
		label={(row: Account) => row.username}
		onopen={open}
		empty="No accounts yet."
	>
		{#snippet cells(row: Account)}
			<td>
				{#if row.disabled}<Badge tone="neutral">Disabled</Badge>{:else}<Badge tone="ok"
						>Active</Badge
					>{/if}
			</td>
			<td
				>{#if row.evidencePacks}<Badge tone="info">Allowed</Badge>{:else}—{/if}</td
			>
			<td>
				{#if row.aiTools}<Badge tone="info"
						>Allowed{row.aiTokenHint === null ? '' : ` · …${row.aiTokenHint}`}</Badge
					>{:else}—{/if}
			</td>
			<td>{row.lastSignInAt === null ? 'Never' : formatDateTime(row.lastSignInAt)}</td>
		{/snippet}
	</DataTable>
	{#if remote.accounts.length > 0}
		<p class="muted small">Click an account to see or change it.</p>
	{/if}

	<h3>Firewall</h3>
	<p class="muted small">
		Lookstow does not open the firewall itself. Let the allowed computers reach port {remote.port}
		with one of these, run as an administrator:
	</p>
	<pre class="command">{remote.firewall.windows}</pre>
	<pre class="command">{remote.firewall.linux.join('\n')}</pre>

	<h3>Who opened what</h3>
	{#if remote.audit.length === 0}
		<p class="muted small">Nobody has used remote access in the last two days.</p>
	{:else}
		<DataTable
			columns={['When', 'Who', 'From', 'What', 'Answer']}
			rows={auditRows}
			key={(row: AuditRow) => row.n}
			compact
		>
			{#snippet cells(row: AuditRow)}
				<td>{formatDateTime(row.line.at)}</td>
				<td>{row.line.user ?? '(not signed in)'}</td>
				<td>{row.line.address}</td>
				<td class="path">{row.line.method} {row.line.path}</td>
				<td>{row.line.status}</td>
			{/snippet}
		</DataTable>
		<p class="muted small">The full trail is in the remote-audit folder in the data folder.</p>
	{/if}
	<Button variant="secondary" onclick={() => (certificateOpen = true)}
		>Make a new certificate…</Button
	>
</Card>

<Modal bind:open={viewOpen} title={`Account: ${account?.username ?? ''}`}>
	{#if account !== undefined}
		<DetailView>
			<dt>Username</dt>
			<dd>{account.username}</dd>
			<dt>Status</dt>
			<dd>
				{#if account.disabled}<Badge tone="neutral">Disabled</Badge> cannot sign in{:else}<Badge
						tone="ok">Active</Badge
					>
					{remote.enabled ? 'can sign in' : 'can sign in once remote access is on'}{/if}
			</dd>
			<dt>Evidence packs</dt>
			<dd>
				{#if account.evidencePacks}<Badge tone="info">Allowed</Badge> can make and download packs{:else}Not
					allowed{/if}
			</dd>
			<dt>AI tools</dt>
			<dd>
				{#if account.aiTools}<Badge tone="info">Allowed</Badge>
					{account.aiTokenHint === null ? '' : `token ends …${account.aiTokenHint}`}{:else}Not
					allowed{/if}
			</dd>
			<dt>Added</dt>
			<dd>{formatDateTime(account.createdAt)}</dd>
			<dt>Last signed in</dt>
			<dd>{account.lastSignInAt === null ? 'Never' : formatDateTime(account.lastSignInAt)}</dd>
		</DetailView>
	{/if}
	{#snippet footer()}
		<div class="footer">
			<div class="left">
				<Button onclick={() => (editOpen = true)}>Edit</Button>
				<Button
					variant="secondary"
					onclick={() => {
						makeForNew = true;
						passwordOpen = true;
					}}>New password…</Button
				>
				{#if account?.aiTools === true}
					<form method="POST" action="?/remoteAiToken" use:enhance>
						<input type="hidden" name="username" value={account.username} />
						<Button type="submit" variant="secondary" title="Make a new token and stop the old one"
							>New AI token</Button
						>
					</form>
				{/if}
			</div>
			<Button variant="danger" onclick={() => (deleteOpen = true)}>Delete…</Button>
		</div>
	{/snippet}
</Modal>

<FormModal
	bind:open={editOpen}
	title={`Edit account: ${account?.username ?? ''}`}
	action="?/remoteAccount"
>
	{#if account !== undefined}
		<input type="hidden" name="username" value={account.username} />
		<Switch
			name="canSignIn"
			checked={!account.disabled}
			hint="Off stops sign-in and the AI token at once and signs them out; nothing is deleted."
			>Can sign in</Switch
		>
		<Switch
			name="evidencePacks"
			checked={account.evidencePacks}
			hint="Can make evidence packs (bulk copies of mail) and download them.">Evidence packs</Switch
		>
		<Switch
			name="aiTools"
			checked={account.aiTools}
			hint="Claude Code on their computer can search, read and make packs, with a token of its own. Turning it on shows the token and setup to send."
			>AI tools</Switch
		>
	{/if}
</FormModal>

<FormModal
	bind:open={passwordOpen}
	title={`New password for ${account?.username ?? ''}`}
	action="?/remotePassword"
>
	<input type="hidden" name="username" value={account?.username ?? ''} />
	<label class="check">
		<input type="checkbox" name="generate" bind:checked={makeForNew} />
		Make a password for me
	</label>
	{#if !makeForNew}
		<label>
			New password (at least 12 characters)
			<input name="password" type="password" required minlength="12" autocomplete="new-password" />
		</label>
		<label>
			The same password again
			<input name="confirm" type="password" required minlength="12" autocomplete="new-password" />
		</label>
	{/if}
	<p class="muted small">
		They are signed out everywhere. The new details then show in a window to copy and send.
	</p>
</FormModal>

<FormModal
	bind:open={deleteOpen}
	title={`Delete ${account?.username ?? ''}`}
	action="?/remoteDelete"
	submitLabel="Delete"
	variant="danger"
	onsuccess={() => (viewOpen = false)}
>
	<input type="hidden" name="username" value={account?.username ?? ''} />
	<p>
		{account?.username} is signed out and can no longer sign in, and their AI token stops working. Their
		lines in the audit trail are kept.
	</p>
</FormModal>

<Modal open={sendTo !== null} title={`Send this to ${sendTo ?? ''}`} size="lg" onclose={sent}>
	<p class="muted small">
		{#if aiShowing !== null}
			Shown once: Lookstow keeps only a scrambled form of the AI token. If it is lost, use New AI
			token.
		{:else if showing?.password !== null}
			Shown once: Lookstow keeps only a scrambled form of the password, so it cannot show it again.
			If it is lost, make another with New password.
		{:else}
			The password you typed is not shown here; give it to them another way.
		{/if}
	</p>
	<textarea readonly rows={aiShowing === null ? 5 : 13} bind:this={box} value={message}></textarea>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
		<Button onclick={sent}>Done</Button>
	{/snippet}
</Modal>

<FormModal bind:open={accessOpen} title="Remote access" action="?/remoteAccess">
	<Switch
		name="enabled"
		checked={remote.enabled}
		hint="Other computers on the network may search and read the backup: HTTPS, signed in, read-only."
		>Remote access</Switch
	>
	<label>
		Port
		<input name="port" type="number" min="1024" max="65535" value={remote.port} required />
	</label>
	<label>
		Computers allowed to connect
		<textarea name="allowList" rows="4" placeholder="10.1.2.3&#10;10.1.5.0/24"
			>{remote.allowList.join('\n')}</textarea
		>
	</label>
	<p class="muted small">
		One address or range per line: 10.1.2.3, a range such as 10.1.2.0/24, or an IPv6 address.
		Everyone else is refused before they see a sign-in page. It can be turned on before there are
		addresses or accounts; nobody gets in until there are.
	</p>
</FormModal>

<FormModal bind:open={addOpen} title="Add a remote account" action="?/remoteAdd" submitLabel="Add">
	<label>
		Username
		<input name="username" required maxlength="40" autocomplete="off" />
	</label>
	<label class="check">
		<input type="checkbox" name="generate" bind:checked={makeForAdd} />
		Make a password for me
	</label>
	{#if !makeForAdd}
		<label>
			Password (at least 12 characters)
			<input name="password" type="password" required minlength="12" autocomplete="new-password" />
		</label>
		<label>
			The same password again
			<input name="confirm" type="password" required minlength="12" autocomplete="new-password" />
		</label>
	{/if}
	<p class="muted small">
		Once added, a window shows the address, username and password to copy and send to the person.
		Five wrong passwords lock the username for 15 minutes.
	</p>
</FormModal>

<FormModal
	bind:open={certificateOpen}
	title="Make a new certificate"
	action="?/remoteCertificate"
	submitLabel="Make it"
>
	<p>
		Use this if the computer's name or address changed, or the certificate is close to its two-year
		end. Every browser warns once more until the person accepts the new one.
	</p>
</FormModal>

<style>
	h3 {
		margin: var(--space-4) 0 var(--space-2);
		font-size: var(--font-size-md);
	}

	.heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.heading h3 {
		margin-bottom: 0;
	}

	.status {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--colour-border-strong);
		border-left-width: 6px;
		border-radius: var(--radius-md);
		background: var(--colour-surface-alt);
	}

	.status.on {
		border-color: var(--colour-ok);
		background: var(--colour-ok-soft);
	}

	.status p {
		margin: 0;
	}

	.state {
		flex-shrink: 0;
		min-width: 3rem;
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
		color: var(--colour-text-muted);
	}

	.on .state {
		color: var(--colour-ok-text);
	}

	.path {
		word-break: break-all;
	}

	.command {
		white-space: pre-wrap;
		word-break: break-all;
		background: var(--colour-surface-alt);
		padding: var(--space-3);
		border-radius: var(--radius-md);
		font-size: var(--font-size-sm);
	}

	.footer {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.footer .left {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	textarea[readonly] {
		width: 100%;
		box-sizing: border-box;
		font-family: var(--font-mono, monospace);
		font-size: var(--font-size-sm);
		resize: vertical;
	}

	.fingerprint {
		word-break: break-all;
	}

	label {
		display: grid;
		gap: var(--space-1);
	}

	label.check {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}

	.muted {
		color: var(--colour-text-muted);
	}

	.small {
		font-size: var(--font-size-sm);
	}
</style>
