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
