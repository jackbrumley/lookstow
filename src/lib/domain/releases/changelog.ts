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
