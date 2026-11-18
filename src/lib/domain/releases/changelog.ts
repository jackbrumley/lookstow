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
