# To do

## Now

- **Test against a real tenant.** Register the app (Settings has the steps), back up 2–3 test mailboxes, check the .eml files open, the folder tree and the counts.
- **Archive test.** Try the beta Mailbox Import/Export API on an archive: list folders and items, export one item, see what format comes back. Then decide how archives are stored (DESIGN.md section 7).
- **Verify discovery's archive lookup** (`/beta/users/{id}/settings/exchange`, `inPlaceArchiveMailboxId`) on a real tenant; fix the property name if it differs.
- **First release.** Move the release key offline and into the `LOOKSTOW_RELEASE_KEY` secret, set up GitHub Pages and the `dev`/`main` branches, tag 0.1.0 (`RELEASE.md`), then run the one-line install on a real Windows server and a Linux VM.
- **Icon.** `docs/assets/icon.png` and a proper app icon (the favicon is a placeholder drawn by hand).

## Next

- **Backup folder outside the data folder.** The Linux unit only lets the service write `/var/lib/lookstow`, and LocalService can only write folders it is granted. Choosing another folder (a second disk, a NAS) needs the installer to grant it (`--backup-dir`) or the unit's `ReadWritePaths` to include it.
- **Completeness check.** Compare each folder's item count in Graph with the index once a day, and show mailboxes that drift.
- **Restore.** Download a mailbox or folder as a zip of .eml or as one .mbox; later, put messages back with Graph (MIME upload) or the import API.
- **Search.** Find a message across the index by sender, subject or date.
- **Retention.** Optionally delete files of messages deleted at the source more than N days ago (off by default).
- **Alerts.** Email when a mailbox has failed for a day or discovery fails (Mailgun or SMTP, as i12-pt6-control does).
- **Remote console** with sign-in (Entra sign-in for admins), then allow other computers.
- **Calendar and contacts** (Graph delta works for both).

## Ideas

- Encrypt stored .eml files at rest with a key outside the backup folder.
- Export a mailbox as PST for people who want Outlook to open it.
- Per-mailbox size and growth charts on the dashboard.
