/**
 * Release notes shared by the console (the Updates page) and release packaging
 * (scripts/release/notes.ts writes each GitHub release's body from its entry).
 * The newest entry comes first, and its version is the version this build runs:
 * it must equal package.json's (checked by changelog.test.ts and before a tag is
 * built). Free of package imports, so the release scripts load it with plain `node`.
 */

/**
 * What to try on real machines before trusting a release: the checks the
 * automated tests cannot make (a real Windows service, a real mailbox).
 */
type ReleaseTesting = { kind: 'none' } | { kind: 'steps'; steps: readonly [string, ...string[]] };

export type Release = {
	version: string;
	testing: ReleaseTesting;
	changes: readonly [string, ...string[]];
};

export const CHANGELOG = [
	{
		version: '0.10.0',
		testing: {
			kind: 'steps',
			steps: [
				'Press Update now: the whole screen shows only the update, counting down from about 3 minutes, and the console comes back by itself on the new version',
				'Settings > Schedule: if Mailboxes at once still says 8 (your saved value from before), set it to 32; Lookstow now adds mailboxes by itself while Microsoft has room and stays below that',
				'Settings has a Speed card with the pace Lookstow has learned; Forget what was learned… resets it (no need to use it now)',
				'Press Sync all now and watch the dashboard for 10 minutes: Syncing goes above 3 mailboxes as Lookstow adds them, and the Speed card shows the pace',
				'Open a mailbox with many messages: if any message could not be copied, an Items that could not be copied card lists it, with Try again now; the rest of the folder copies regardless',
				'If a mailbox fails (for example a permission is missing), the dashboard shows a Failing line with the kind of failure, and that mailbox is tried again after 30 seconds, then less often up to every 15 minutes'
			]
		},
		changes: [
			'Updating now takes over the whole screen until the new version is running, so nothing is started that the restart would cut off, and the countdown starts at 3 minutes (what updates take)',
			'Mailboxes at once is decided by the governor: Lookstow adds a mailbox every 10 seconds while every slot is busy, mailboxes are waiting and Microsoft has room, and adds none while Microsoft asks it to slow down. The most at once is now 32 by default',
			'One message that cannot be copied no longer stops its folder: it is recorded, the folder goes on, and it is tried again after 15 minutes, an hour, 4 hours, then daily. The mailbox page lists such items with Try again now. Online archive items work the same way',
			'Messages are written to disk as they download, so a large message no longer has to fit in memory; each mailbox copies three folders at once, fetching the next page while the current one downloads',
			'After Microsoft restarts a folder’s change list, Lookstow checks which stored messages are no longer in the folder, so deletions are not missed',
			'A mailbox whose sync fails is tried again after 30 seconds, doubling to at most 15 minutes, and the dashboard says how many mailboxes are failing and why (permission, network, disk, Microsoft, slowed down)',
			'Settings has a Speed card: the pace Lookstow has learned from Microsoft, and Forget what was learned',
			'The pace settles at 90% of the rate Microsoft refused (was 85%), and saves no burst of requests during a pause: tested against a simulated Microsoft, it now holds 91–94% of the limit with one refusal an hour, where before it could be cut five times in a row'
		]
	},
	{
		version: '0.9.0',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, the dashboard shows a Speed card: download rate, requests a second against what Microsoft allows, requests in flight, and whether Microsoft has asked Lookstow to slow down',
				'Open http://127.0.0.1:8030/api/throughput: the same numbers as JSON, with mailboxes shown only as mailbox-1, mailbox-2 and so on',
				'Press Sync now on Jason’s online archive: its download rate is well above the 2.8 MB/s seen before (several export batches now run at once)',
				'Leave it syncing for an hour: the Speed card’s Pace climbs while Microsoft allows it; if Microsoft throttles, Pace changes lists one cut and the pace holds just under the limit',
				'Restart the service (or update again): the Speed card starts at the pace it had learned, not from the beginning'
			]
		},
		changes: [
			'A throughput governor paces every request to Microsoft: each mailbox runs as many requests at once as Microsoft allows, and the app as a whole climbs to the fastest pace Microsoft accepts, settles just under it when Microsoft asks it to slow down, and remembers that pace across restarts',
			'Online archives export several batches at once instead of one, within a memory budget, so a large archive copies several times faster',
			'When Microsoft asks for a pause, every request to that mailbox (or the whole app) waits it out together, then one request checks before the rest resume, so the pause is not made longer',
			'Requests that get no reply in 30 seconds, and downloads that stall for 60 seconds, are stopped and tried again instead of holding a mailbox for good; signing in happens once for all requests, and again once if Microsoft withdraws a token',
			'The dashboard has a Speed card, and http://127.0.0.1:8030/api/throughput gives the same numbers as JSON; a history of them, sampled every 10 seconds, is kept for 7 days in the data folder (no addresses, names or ids)',
			'This release also brings 0.7.0 and 0.8.0, which were not published on their own'
		]
	},
	{
		version: '0.8.0',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, wait for a sync of a backed-up mailbox, then open its page: the Folders table has a Microsoft says column with Microsoft’s count for each folder',
				'Where a folder’s count differs from the stored messages, it is marked, and a note under the table says why small differences are normal',
				'Open the dashboard: Completeness says every checked folder matches, or how many mailboxes differ. If some differ, open Mailboxes and tick Differs from Microsoft to list only those'
			]
		},
		changes: [
			'Lookstow now checks that each backup is complete: after every sync it records how many items Microsoft says each folder holds, and shows that beside the number it has stored. Folders that differ are marked on the mailbox page, the dashboard says how many mailboxes differ, and Mailboxes can list only those',
			'The numbers are shown as they are, with no alert yet: small differences are normal (mail arriving during a sync, and items in a mail folder that are not messages). Alerts will follow once real numbers show which differences matter'
		]
	},
	{
		version: '0.7.0',
		testing: {
			kind: 'steps',
			steps: [
				'A few minutes after the update, open the backup folder: it holds a .lookstow-index folder with one lookstow-<today>.db file, and the dashboard shows Index copy with today’s time',
				'Open Settings > Backup folder: Index snapshots shows the last copy, its size and the folder. With the default backup folder it also says the copies are on the same drive as the index',
				'Open How it works in the side bar: it shows this computer’s own sync interval, backup folder and index copy folder, and the steps to put a copy back',
				'Open an online archive’s mailbox page: if any item could not be read for Search, it says how many under Not readable. Restart the service: the Log does not repeat the same warning for those items',
				'Optional: open Alerts and tick The index cannot be copied for someone, so a failed copy is emailed'
			]
		},
		changes: [
			'Lookstow copies its index to the backup drive once a day and keeps the newest 7. The index records every message’s folder and history; if it is ever lost, putting back a copy loses at most a day of history instead of all of it, and nothing is downloaded twice. How to do it is on the new How it works page and in the README',
			'A failed copy is an error under Recent problems on the dashboard, and an email alert you can turn on (The index cannot be copied). Lookstow tries again every hour',
			'New How it works page: what Lookstow copies and when, how online archives and dates work, what happens when mail is moved or deleted in Microsoft 365, and how to restore the index, with this computer’s own folders and schedule',
			'An online archive item Lookstow cannot read is tried once per version, not at every start. Its mailbox page says how many could not be read; they stay stored as they came'
		]
	},
	{
		version: '0.6.2',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, Activity soon says how many online archive items were filed under the month they were received (Log names any that could not be moved)',
				'In C:\\ProgramData\\Lookstow\\mailboxes, Jason’s archive folder now holds years like his mailbox’s (2018, 2019 …), and an item’s file date matches its received date in Search',
				'Open an archive item from Search and download it again: both the .eml and the original .fts still work',
				'In Settings > What is backed up > Change, and in a mailbox’s Exclude or Delete backup: each radio button sits level with its text'
			]
		},
		changes: [
			'Online archive items copied before 0.6.0 are moved, once, to the month they were received, so an archive’s folders match its mailbox’s. The files are renamed on the same drive and are otherwise unchanged',
			'Radio buttons and checkboxes everywhere line up with the first line of their text'
		]
	},
	{
		version: '0.6.1',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, open Settings: What is backed up says how many mailboxes that are not backed up still have backups, and their size (15 mailboxes on the test machine)',
				'Open What is backed up > Change, leave the mailboxes as they are, choose Delete them from the backup drive, type DELETE and Save: the toast says how many backups were deleted, and the mailboxes folder on the backup drive holds only the mailboxes you back up',
				'Open Activity: one Backup deleted entry for each of those mailboxes, and a What is backed up was changed entry saying how many were deleted',
				'Open the mailbox page of a mailbox whose first copy was cut off before (abby.aguinaldo@midfield.com.au): before deleting, it showed its real message count and a Delete backup button'
			]
		},
		changes: [
			'What is backed up: Delete now deletes the backup of every mailbox that is not backed up, also those left out by an earlier change. Before, it only covered mailboxes that stopped in that same save, so choosing it later deleted nothing and said nothing',
			'A mailbox whose first copy stopped part-way now shows its real message count. Before, it showed 0 until a sync finished, which hid its backup from Delete backup, Search this mailbox and the What is backed up choice. Counts left wrong by earlier versions are corrected at start-up',
			'Settings shows how many mailboxes that are not backed up still have backups on the drive, and their size'
		]
	},
	{
		version: '0.6.0',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, Activity soon says how many online archive items stored earlier can now be found in Search (Log names any that could not be read)',
				'In Search, pick Jason’s online archive as the mailbox and search for a sender or a word in a subject: archive items come back with their subject, sender and received date',
				'Open an archive item and press Download .eml: it opens in Outlook with its body, inline pictures, attachments, and any attached email',
				'Download the original (.fts) of the same item: it is the file exactly as Microsoft exported it',
				'Press Sync now on the archive: items copied from now on are filed under the year and month they were received'
			]
		},
		changes: [
			'Online archive items can be read: Lookstow reads Exchange’s full-fidelity export itself, so Search finds archive items by subject, sender, recipients, date and Message-ID, like normal mail',
			'Download .eml for any archive item: a copy that Outlook and other mail programs open, with the body, inline pictures, attachments and attached emails. The original .fts file is kept unchanged and can still be downloaded',
			'Archive items copied from now on are filed by the date they were received, not the date they moved into the archive (often two years later). Items copied earlier keep their place on disk and are found by their received date in Search'
		]
	},
	{
		version: '0.5.1',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, open the online archive’s mailbox page (Jason Shaw (archive)) and press Sync now: its message count grows, and Log shows no "Bad control character" error',
				'When the archive’s first copy is done, its page says First full copy: Done, and Search with that archive as the mailbox lists its items by date'
			]
		},
		changes: [
			'Online archives: copying no longer stops at an item whose export reply holds a raw control character. Microsoft’s export API sends such replies, and Lookstow refused them, so the archive stayed stuck at the same batch'
		]
	},
	{
		version: '0.5.0',
		testing: {
			kind: 'steps',
			steps: [
				'Open Alerts > Sending email > Set up: enter the Mailgun sending domain (as i12-pt6-control uses), the region and a sending key, then Save',
				'Add yourself under Who gets alerts, tick every alert, and press Send a test: the toast says Sent, and the email arrives',
				'Change the key to a wrong one and Send a test: the toast says Mailgun refused it and what to check; put the right key back',
				'Pause a mailbox you picked, then Resume it and press Sync now on its archive while the archive permissions are missing (or wait for a real failure): an alert email names the mailbox and Microsoft’s reason',
				'Check the Emails list on the Alerts page: every email shows Sent, Waiting to retry, Failed or Not sent, with the reason'
			]
		},
		changes: [
			'Email alerts, as in I12 and PT6 Control: sent through Mailgun to the people you choose, each with the alerts they want: a mailbox failing or syncing again, discovery failing, the backup drive full, mailboxes found or gone, a first copy finished, backups deleted or the mailboxes backed up changed, and automatic updates',
			'A new Alerts page: the Mailgun setup (the key is stored sealed and never shown), who gets which alerts, a test email for each person, and every email with its result',
			'A failed send is tried again after 1, 5, 15 and 30 minutes, then hourly, so a Mailgun outage delays an alert instead of losing it'
		]
	},
	{
		version: '0.4.4',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.4.4, then open Updates > Last update: "downloaded and unpacked" and "started the new release" each take seconds, not a minute',
				'On a mailbox page, press Search this mailbox: Search opens with that mailbox filled in, with no error',
				'In Search, type an address two mailboxes share: the list shows it once, and the search covers the mailbox still in Microsoft 365',
				'If the update did not start within seconds, Log shows "Could not start the updater task at once" with the reason on the same line'
			]
		},
		changes: [
			'Updates: the update archive holds a few hundred files instead of about 4,000, so unpacking takes seconds',
			'Updates on Windows: the data folder’s permissions are checked, and reset across every backed-up file only when they changed, instead of on every update',
			'Search: Search this mailbox no longer fails with an error when two mailboxes share an address',
			'The log gives the full reason when the updater cannot be started at once'
		]
	},
	{
		version: '0.4.3',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, the dashboard shows Moving files with a count while files stored before 0.4.0 move into the date layout; syncs start when it finishes',
				'In the backup folder, each mailbox holds only year and month folders; the old Inbox, Sent Items and other mail-folder folders are gone',
				'Search finds an old message and its download still opens',
				'In Search, type two or three letters of an address in Mailbox: the list narrows to matching mailboxes, and the field no longer covers Words'
			]
		},
		changes: [
			'Files stored before 0.4.0 are moved once into the date layout (mailbox/year/month); which folder each message is in is kept only in the database. The move renames files on the same drive, so it is quick and the files are unchanged',
			'Search: the Mailbox field is a box you type into, with a list that narrows as you type, and it stays inside its column'
		]
	},
	{
		version: '0.4.2',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.4.2 (this update still waits for the old two-minute task; it installs the new one)',
				'On the Updates page, Last update lists how long each step took',
				'When the next release is out, press Update: the updater starts within seconds (Log says "Started the updater task"), and Last update shows the steps'
			]
		},
		changes: [
			'Windows: the console starts the updater the moment you press Update, instead of waiting up to two minutes for its timer; the timer now also runs every minute as a fallback',
			'Windows: the updater also runs on battery (it did not start on battery before), and never twice at once',
			'The Updates page shows how long each step of the last update took: the wait, download and unpack, stopping the service, the database backup and the start'
		]
	},
	{
		version: '0.4.1',
		testing: {
			kind: 'steps',
			steps: [
				'Settings > Test connection shows an Online archive permissions step: it lists any of the three archive permissions not granted yet',
				'After adding them and granting admin consent, Test connection passes that step, and the next archive sync copies items',
				'Open Log: every failed sync now has a line, and archives are named "(online archive)"'
			]
		},
		changes: [
			'A reply from Microsoft that is cut off, garbled or ends early is asked for again, instead of failing the mailbox ("terminated", "invalid bit length repeat", "Unexpected end of JSON input")',
			'A timeout while signing in to Microsoft Entra is retried, instead of failing the mailbox',
			'Test connection shows which online archive permissions Microsoft has granted, and which are missing',
			'The log shows every failed sync, not only the first of a run of failures, and names online archives as such (here and on the dashboard)'
		]
	},
	{
		version: '0.4.0',
		testing: {
			kind: 'steps',
			steps: [
				'In Entra, add the application permissions MailboxFolder.Read.All, MailboxItem.Read.All and MailboxItem.Export.All to the Lookstow app and grant admin consent',
				'Pick a mailbox that has an online archive: its archive syncs too, and its page lists the archive folders and a growing message count',
				'Without those permissions, the archive fails with a message naming them, and the mailbox itself still syncs',
				'Open Search: find a message by sender, by To, by subject words and by date; open it, see its history, and download the .eml (it opens in Outlook)',
				'Move a message to another folder in Outlook, sync the mailbox, and its history shows the move; its file stays where it was'
			]
		},
		changes: [
			'Online archives are copied, auxiliary (auto-expanded) archives included, through Microsoft’s mailbox export API. Each item is stored as Exchange’s full-fidelity export (.fts). This needs three more Graph permissions: see the testing steps',
			'New messages are filed by date (mailbox/yyyy/mm/date_subject_id.eml) and never move again; folder moves, deletes and restores are kept as each message’s history. Files stored by earlier versions stay where they are',
			'Search: find stored messages by words, sender, To or Cc, subject, folder, Message-ID, date and mailbox, then open one to see its details and history and download it',
			'A mailbox stopped by Pause or a restart starts again at once instead of waiting for its next turn',
			'The dashboard shows how many mailboxes wait for their next turn, and when the next one is due',
			'The Updates page follows an update started anywhere (automatic ones too) and reloads when it is installed; any open page offers a reload when a new version is running'
		]
	},
	{
		version: '0.3.0',
		testing: {
			kind: 'steps',
			steps: [
				'With a few mailboxes syncing, the dashboard shows a download rate that moves, and how many mailboxes sync at a time',
				'Press Discover now: the dashboard counts users checked and mailboxes found while it runs',
				'Open Log: new lines appear every two seconds; search, the level filter and Copy work',
				'With many mailboxes picked, watch Microsoft throttling on the dashboard: when it appears, fewer mailboxes sync at once',
				'On Mailboxes, sort by Size and move between pages; on Activity, Older entries pages back'
			]
		},
		changes: [
			'Live download rate (MB/s and messages/s, last minute and last 15 minutes) and Microsoft throttling on the dashboard',
			'Lookstow adjusts how many mailboxes sync at once: more while Microsoft allows it, fewer when it asks to slow down (Settings sets the most, now up to 32)',
			'Discovery shows its progress: users checked and mailboxes found so far',
			'A Log page: the service log, live, with search, a level filter and copy',
			'Mailboxes sort by any column and come in pages of 100; Activity pages back with Older entries'
		]
	},
	{
		version: '0.2.0',
		testing: {
			kind: 'steps',
			steps: [
				'Press Pause at the side of any page while mailboxes sync: they stop within a page of messages, and Resume carries on where they stopped',
				'On a mailbox page, Pause and Resume just that mailbox',
				'Exclude (or Unpick) a mailbox that has a backup: choose Keep, then try again on another with Delete and the address typed; the files are gone and Activity says so',
				'In Settings > Disk space, set the pause limit below how full the drive is now: backups pause with a red banner and Resume refuses until the limit is raised',
				'With a large first copy running, a mailbox already backed up still syncs on its own timer'
			]
		},
		changes: [
			'Pause and Resume for everything, from any page, and for each mailbox on its page',
			'Disk guard: a warning at 85% of the backup drive and an automatic pause at 90% (both in Settings), shown on the dashboard',
			'Excluding or unpicking a mailbox, or changing what is backed up, asks whether to keep or delete the backups it had; deleting needs a typed confirmation',
			'Each mailbox now syncs on its own timer, and first copies never take every slot, so mailboxes already backed up keep syncing during a long first copy',
			'The dashboard shows what is syncing, what is waiting in each queue, discovery and the backup drive'
		]
	},
	{
		version: '0.1.1',
		testing: {
			kind: 'steps',
			steps: [
				'From 0.1.0, let the install update itself (or choose Update now): the Updates page reloads into 0.1.1',
				'Settings > What is backed up > Only the mailboxes I pick, then Pick two mailboxes on the Mailboxes page: only those two are copied',
				'Test connection on a tenant whose first users have no mailbox: it skips them and passes, naming the mailbox it tested on',
				'Move between pages after finishing the setup: the "Enter the tenant ID" banner is gone everywhere'
			]
		},
		changes: [
			'Back up only the mailboxes you pick: Settings > What is backed up, then Pick on the Mailboxes page',
			'Test connection skips users without a mailbox (inactive, soft-deleted or on-premises) instead of failing on them',
			'Discovery starts as soon as Microsoft 365 is connected, not hours later',
			'The page frame refreshes on every page, so an old setup warning no longer lingers; the dashboard says when a sync of every mailbox is running',
			'An empty reply from Microsoft Graph is asked for again instead of failing the mailbox',
			'The app icon sits on a light tile in the sidebar, so it stands out'
		]
	},
	{
		version: '0.1.0',
		testing: {
			kind: 'steps',
			steps: [
				'On a fresh Ubuntu or Debian machine, run the install command from https://brumley.info/lookstow: it ends by printing http://127.0.0.1:8030, and that address opens the console',
				'In an administrator PowerShell on Windows 10 or 11, run the install command: the Lookstow service is running and http://127.0.0.1:8030 opens the console',
				'Run the install command again on both: the data and the secrets key are kept',
				'Uninstall with the command the installer printed, then with --purge: the program folder, and then the data folder, are gone'
			]
		},
		changes: [
			'First release: Lookstow backs up Microsoft 365 mailboxes, shared mailboxes and online archives to a folder on this computer, as a service for Windows and Linux with a console at http://127.0.0.1:8030',
			'One-line installers for Linux and Windows, and signed automatic updates of the whole install from the console'
		]
	}
] as const satisfies readonly [Release, ...Release[]];
