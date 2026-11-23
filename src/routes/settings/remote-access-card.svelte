<!--
	Settings, Remote access (docs/specs/SPEC-REMOTE.md): other computers on the network may
	search, open and download messages over HTTPS, from allowed addresses, with an account.
	Every change applies at once; every remote request is in the audit trail shown here.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import FormModal from '#lib/ui/form-modal.svelte';
	import { formatDateTime } from '#lib/utils/format.ts';
	import type { RemoteView } from '#lib/domain/remote.ts';
	import { toast } from '#lib/runes/toast.svelte.ts';

	interface Props {
		remote: RemoteView;
		/** An account just added or given a new password: shown once, to copy and send. */
		credentials: { username: string; password: string | null } | null;
	}

	let { remote, credentials }: Props = $props();

	let accessOpen = $state(false);
	let addOpen = $state(false);
	let certificateOpen = $state(false);
	let passwordFor = $state<string | null>(null);
	let deleting = $state<string | null>(null);
	let passwordOpen = $state(false);
	let deleteOpen = $state(false);
	// Lookstow makes the password unless someone wants to type their own.
	let makeForAdd = $state(true);
	let makeForNew = $state(true);

	// The details to send, until Done; each new set shows again.
	let dismissed = $state<unknown>(null);
	const showing = $derived(credentials !== null && dismissed !== credentials ? credentials : null);
	const message = $derived(
		showing === null
			? ''
			: [
					`Lookstow (read-only access to the mail backup): ${remote.address}`,
					`Name: ${showing.username}`,
					`Password: ${showing.password ?? '(the one you were given)'}`,
					remote.fingerprint === null
						? 'Your browser warns about the certificate the first time; accept it to go on.'
						: `Your browser warns about the certificate the first time. Its SHA-256 fingerprint is ${remote.fingerprint}.`
				].join('\n')
	);
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
</script>

<Card title="Remote access" tone={remote.problem === null ? 'plain' : 'warn'}>
	{#snippet actions()}
		<Button variant="secondary" onclick={() => (addOpen = true)}>Add account…</Button>
		<Button variant="secondary" onclick={() => (accessOpen = true)}>Change…</Button>
	{/snippet}
	<p>
		{#if remote.enabled}
			<Badge tone="ok">On</Badge> People with an account can search, open and download messages from the
			allowed computers at <code>{remote.address}</code>. They cannot change anything.
		{:else}
			<Badge tone="neutral">Off</Badge> Lookstow answers only on this computer. Turn this on to let others
			on the network search and read the backup, signed in and read-only.
		{/if}
	</p>
	{#if remote.problem !== null}
		<p class="problem" role="alert">{remote.problem}</p>
	{/if}
	{#if showing !== null}
		<div class="send" role="status">
			<strong>Send this to {showing.username}</strong>
			{#if showing.password !== null}
				<span class="muted small"
					>Shown once: Lookstow keeps only a scrambled form of the password, so it cannot show it
					again. If it is lost, use New password….</span
				>
			{/if}
			<textarea readonly rows="5" bind:this={box} value={message}></textarea>
			<div class="send-buttons">
				<Button size="sm" onclick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
				<Button size="sm" variant="ghost" onclick={() => (dismissed = credentials)}>Done</Button>
			</div>
		</div>
	{/if}
	<p class="muted small">
		Allowed: {remote.allowList.length === 0 ? 'nobody yet' : remote.allowList.join(', ')}. Port
		{remote.port}. The certificate is self-signed: each browser warns once until the person accepts
		it.
		{#if remote.fingerprint !== null}
			Check its SHA-256 fingerprint matches <code class="fingerprint">{remote.fingerprint}</code>.
		{/if}
	</p>

	<h3>Accounts</h3>
	{#if remote.accounts.length === 0}
		<p class="muted">No accounts yet.</p>
	{:else}
		<table>
			<thead
				><tr><th>Name</th><th>State</th><th>Evidence packs</th><th>Last signed in</th><th></th></tr
				></thead
			>
			<tbody>
				{#each remote.accounts as account (account.username)}
					<tr>
						<td>{account.username}</td>
						<td>
							{#if account.disabled}<Badge tone="neutral">Disabled</Badge>{:else}<Badge tone="ok"
									>Active</Badge
								>{/if}
						</td>
						<td>
							<form method="POST" action="?/remoteEvidence" use:enhance>
								<input type="hidden" name="username" value={account.username} />
								<input type="hidden" name="allowed" value={account.evidencePacks ? '' : 'on'} />
								<Button
									type="submit"
									size="sm"
									variant="ghost"
									title={account.evidencePacks
										? 'May make and download evidence packs (bulk copies of mail). Press to stop it.'
										: 'Press to let this account make and download evidence packs (bulk copies of mail).'}
									>{account.evidencePacks ? 'Allowed' : 'Not allowed'}</Button
								>
							</form>
						</td>
						<td>{account.lastSignInAt === null ? 'Never' : formatDateTime(account.lastSignInAt)}</td
						>
						<td class="row-actions">
							<form method="POST" action="?/remoteDisable" use:enhance>
								<input type="hidden" name="username" value={account.username} />
								<input type="hidden" name="disabled" value={account.disabled ? '' : 'on'} />
								<Button type="submit" size="sm" variant="secondary"
									>{account.disabled ? 'Enable' : 'Disable'}</Button
								>
							</form>
							<Button
								size="sm"
								variant="secondary"
								onclick={() => {
									passwordFor = account.username;
									passwordOpen = true;
								}}>New password…</Button
							>
							<Button
								size="sm"
								variant="ghost"
								onclick={() => {
									deleting = account.username;
									deleteOpen = true;
								}}>Delete…</Button
							>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
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
		<table class="audit">
			<thead><tr><th>When</th><th>Who</th><th>From</th><th>What</th><th>Answer</th></tr></thead>
			<tbody>
				{#each remote.audit as line, index (index)}
					<tr>
						<td>{formatDateTime(line.at)}</td>
						<td>{line.user ?? '(not signed in)'}</td>
						<td>{line.address}</td>
						<td class="path">{line.method} {line.path}</td>
						<td>{line.status}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="muted small">The full trail is in the remote-audit folder in the data folder.</p>
	{/if}
	<Button variant="secondary" onclick={() => (certificateOpen = true)}
		>Make a new certificate…</Button
	>
</Card>

<FormModal bind:open={accessOpen} title="Remote access" action="?/remoteAccess">
	<label class="check">
		<input type="checkbox" name="enabled" checked={remote.enabled} />
		Let other computers on the network search and read the backup (HTTPS, signed in, read-only)
	</label>
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
		Everyone else is refused before they see a sign-in page.
	</p>
</FormModal>

<FormModal bind:open={addOpen} title="Add a remote account" action="?/remoteAdd" submitLabel="Add">
	<label>
		Name
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
		Once added, the address, name and password show here to copy and send to the person. Five wrong
		passwords lock the name for 15 minutes.
	</p>
</FormModal>

<FormModal
	bind:open={passwordOpen}
	title={`New password for ${passwordFor ?? ''}`}
	action="?/remotePassword"
>
	<input type="hidden" name="username" value={passwordFor ?? ''} />
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
		They are signed out everywhere. The new details show here to copy and send.
	</p>
</FormModal>

<FormModal
	bind:open={deleteOpen}
	title={`Delete ${deleting ?? ''}`}
	action="?/remoteDelete"
	submitLabel="Delete"
	variant="danger"
>
	<input type="hidden" name="username" value={deleting ?? ''} />
	<p>
		{deleting} is signed out and can no longer sign in. Their lines in the audit trail are kept.
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

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		text-align: left;
		padding: var(--space-2);
		border-bottom: 1px solid var(--colour-border);
		vertical-align: middle;
	}

	.row-actions {
		display: flex;
		gap: var(--space-2);
		justify-content: flex-end;
		flex-wrap: wrap;
	}

	.audit td {
		font-size: var(--font-size-sm);
	}

	.path {
		word-break: break-all;
	}

	.command {
		white-space: pre-wrap;
		word-break: break-all;
		background: var(--colour-surface-muted, var(--colour-border));
		padding: var(--space-3);
		border-radius: var(--radius-md);
		font-size: var(--font-size-sm);
	}

	.send {
		display: grid;
		gap: var(--space-2);
		margin: var(--space-3) 0;
		padding: var(--space-3);
		border-radius: var(--radius-md);
		background: var(--colour-surface-muted, var(--colour-border));
	}

	.send textarea {
		font-family: var(--font-mono, monospace);
		font-size: var(--font-size-sm);
		resize: vertical;
	}

	.send-buttons {
		display: flex;
		gap: var(--space-2);
	}

	.fingerprint {
		word-break: break-all;
	}

	.problem {
		color: var(--colour-bad-text);
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
