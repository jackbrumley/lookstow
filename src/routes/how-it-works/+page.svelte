<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { plural } from '#lib/utils/format.ts';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="How it works"
	lede="What Lookstow does with your Microsoft 365 mail, in plain words."
/>

<Card title="What Lookstow does">
	<p>
		It keeps a copy of your Microsoft 365 mail on a drive you control: user mailboxes, shared
		mailboxes and online archives. Each message is one file you can open without Lookstow.
	</p>
</Card>

<Card title="How it signs in">
	<p>
		With an app registration in your tenant and a certificate. Its permissions let it read mail and
		mailbox settings; it cannot send, change or delete anything in Microsoft 365. The certificate's
		private key is stored encrypted on this computer.
	</p>
</Card>

<Card title="What it copies, and when">
	<p>
		Every mailbox discovery finds, or only the ones you pick: see
		<a href={resolve('/settings')}>Settings</a>, What is backed up. Lookstow looks for new and
		removed mailboxes every {plural(data.discoverEveryHours, 'hour')}.
	</p>
	<p>
		Every {plural(data.syncEveryMinutes, 'minute')}, it asks Microsoft what changed in each folder
		since last time and downloads only the new messages. Progress is saved after every page, so a
		stop or a crash loses almost nothing. A first copy of a large mailbox can take hours; later
		syncs take seconds.
	</p>
</Card>

<Card title="Online archives">
	<p>
		Microsoft lets online archives be exported only in Exchange's own format, so they are stored as
		.fts files: complete, and able to be imported back into Exchange. Lookstow reads them for
		Search, and turns any one into an .eml file when you download it. The .fts file stays the
		record.
	</p>
</Card>

<Card title="Where the files go">
	<p>
		In <code>{data.backupRoot}</code>: one folder per mailbox, then one folder per year and month,
		by the date each message arrived. For an archive item that is the date inside the item, not the
		date it was archived. A file is written once and never moved after that.
	</p>
	<p>
		The folder each message is in, and every move, live in Lookstow's index and show on the
		message's page.
	</p>
</Card>

<Card title="Checking the backup is complete">
	<p>
		After each folder syncs, Lookstow asks Microsoft how many items the folder holds and shows it
		beside the number it has stored. Two things explain a higher count from Microsoft: items waiting
		to be copied again after a failure, and items in a mail folder that are not messages (Deleted
		Items can hold contacts and calendar items).
	</p>
	<p>
		Hidden folders and folders that do not hold mail (Outlook's PersonMetadata, contacts, calendars)
		are not compared. Any other difference is <strong>Checking</strong>: nothing to do. If it lasts
		half an hour, Lookstow reads the folder again from the start: it copies what is missing, records
		what is gone and counts the items that are not messages. It does this at most once a day per
		folder. Only if the difference is still there a day after that does it become
		<strong>Needs a look</strong>: the dashboard says so, the activity log records it, and the "A
		folder stays different from Microsoft" alert emails it. Mailboxes can show either state from its
		State list.
	</p>
</Card>

<Card title="The backup folder">
	<p>
		A small file, <code>.lookstow-backup</code>, marks the backup folder as this Lookstow's backup.
		If the folder is missing or unmarked, for example because its drive is not attached, backups
		stop until it is back, instead of starting again somewhere else.
	</p>
	<p>
		To move the backup to another drive, an administrator prepares an empty folder on the server
		with <code>lookstow backup-folder prepare</code>, then chooses Move in Settings, Backup folder.
		Lookstow stops backups, copies every file, checks each copy against the index, and carries on in
		the new folder. The old copy stays until someone removes it by typing REMOVE, and then only
		files whose copy is identical are deleted.
	</p>
</Card>

<Card title="When mail is moved or deleted in Microsoft 365">
	<ul class="plain">
		<li>A moved message is recorded as a move. Its file stays.</li>
		<li>A deleted message is marked deleted. Its file stays, and Search still finds it.</li>
		<li>A mailbox removed from Microsoft 365 is marked gone. Its files stay.</li>
	</ul>
	<p>Lookstow never deletes a backup because something was deleted at the source.</p>
</Card>

<Card title="Deleting backups">
	<p>Only you can delete a backup, and every deletion is in the activity log:</p>
	<ul class="plain">
		<li>one mailbox at a time, by typing its address;</li>
		<li>
			or every mailbox that is not backed up, by typing DELETE in What is backed up. That includes
			mailboxes gone from Microsoft 365 that are not backed up.
		</li>
	</ul>
</Card>

<Card title="The index, and its daily copy">
	<p>
		The index (<code>lookstow.db</code> in <code>{data.dataDir}</code>) records each message's
		folder and history, what was deleted at the source, and where each folder's sync got to. Once a
		day Lookstow copies it to <code>{data.snapshotFolder}</code> and keeps the newest
		{data.snapshotsKept}.
	</p>
	<p>If the index is ever lost or damaged:</p>
	<ol>
		<li>
			Stop the Lookstow service (Windows: <code>Stop-Service Lookstow</code>; Linux:
			<code>sudo systemctl stop lookstow</code>).
		</li>
		<li>
			Copy the newest <code>lookstow-&lt;date&gt;.db</code> from the copies folder over
			<code>lookstow.db</code>, and delete <code>lookstow.db-wal</code> and
			<code>lookstow.db-shm</code> beside it if they are there.
		</li>
		<li>Start the service again.</li>
	</ol>
	<p>
		Syncs carry on from where the copy left off. Mail stored since that copy is downloaded again
		into the same files, so nothing is doubled. History recorded since the copy is lost: at most a
		day.
	</p>
</Card>

<Card title="Updates">
	<p>
		Lookstow checks for signed releases once a day: see <a href={resolve('/updates')}>Updates</a>.
		An update copies the index first, and goes back to the old version by itself if the new one does
		not start.
	</p>
</Card>

<Card title="What Lookstow never does">
	<ul class="plain">
		<li>It does not change anything in Microsoft 365.</li>
		<li>
			It talks only to Microsoft, GitHub (for updates) and Mailgun (only if you set up email
			alerts).
		</li>
		<li>It does not answer other computers: this console opens only on this machine.</li>
	</ul>
</Card>

<style>
	.plain,
	ol {
		margin: 0;
		padding-left: var(--space-5);
		display: grid;
		gap: var(--space-2);
	}
</style>
