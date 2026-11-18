# To do

The first real run (0.1.0, 18 November 2026: 1,816 mailboxes in 1,770 users, archives found) showed what Lookstow needs next. Each phase is one release.

## Now: 0.2, control and safety

- **Pause and Resume, everywhere.** A Pause / Resume button in the page frame, always visible: pausing stops every running sync after its current page and stops the schedule; resuming carries on where each folder stopped. Per mailbox too (pause one mailbox, on its page and the Mailboxes list).
- **Disk guard.** Show free space on the backup folder's drive (dashboard and Settings). Warn at 85% used; pause all syncs automatically at 90% with a clear error, and resume only when someone presses Resume after freeing space. Both thresholds in Settings.
- **Scope changes ask what to do with existing backups.** Excluding or unpicking a mailbox that has a backup, or switching from every mailbox to picked mailboxes, opens a dialog: keep the backup (default) or delete its files. Deleting needs the address typed to confirm, is recorded in Activity, and removes the files and index rows.
- **Per-mailbox scheduling instead of passes.** Each mailbox is due when its last sync plus the interval has passed. First copies have their own queue and a share of the parallel slots, so a 50 GB first copy never holds back the 15-minute syncs of mailboxes already copied.
- **Settings take effect at once.** Say so on the Settings page; scope and schedule are already re-read every tick.

## Next: 0.3, visibility and throughput

- **Live Now panel.** Overall download rate (MB/s, messages/s, last minute and last 15 minutes), each active mailbox's rate and folder, first copies queued / done / estimated time left, and Graph throttling (429 replies per minute, current back-off). Updates every few seconds while work runs.
- **Discovery progress.** "Checked 640 of 1,770 users, found 612 mailboxes", live, instead of nothing until it ends.
- **Log screen.** The service's technical log in the console: live tail, level filter, search, copy. Activity stays the plain-words summary.
- **Adaptive throughput, as SomeDrive does.** Graph allows about 4 concurrent requests per mailbox, so speed comes from parallel mailboxes. Raise them step by step while there is no throttling, halve on 429s; a ceiling and an optional bandwidth cap in Settings.
- **Mailboxes list at scale.** Paging, sorting by any column, and filters kept in the address bar; Activity paging.

## Then: 0.4, email alerts and the update popup

- **Email settings, as in i12-pt6-control.** SMTP host, port, TLS, user and password (sealed), sender address, and Send a test email. Recipients each choose their alerts: a mailbox failing for N hours, discovery failing, disk at 85% / 90%, a first copy finished, a mailbox gone from Microsoft 365, an update installed or failed, and a daily summary. Sent through an outbox with retries.
- **Update popup.** A dismissable dialog in the middle of the screen when a newer release waits: Update now or Later. Comes back after 24 hours (per browser). With automatic updates on, it says when the update will install.

## Then: 0.5, find mail

- **Search page.** By subject, sender, date range, mailbox and Internet Message-ID; SQLite FTS5 on subject and sender.
- **Message view.** Headers, plain-text body, attachment list, download .eml; shows the Message-ID, Graph's immutable id and the file's SHA-256.

## Later

- **Archive copy.** Try the beta Mailbox Import/Export API on an archive (discovery's archive lookup is verified on a real tenant); decide how archives are stored (DESIGN.md section 7).
- **Backup folder outside the data folder.** The Linux unit only lets the service write `/var/lib/lookstow`, and LocalService can only write folders it is granted: the installer grants a chosen folder (`--backup-dir`).
- **Completeness check.** Compare each folder's item count in Graph with the index once a day, and show mailboxes that drift.
- **Restore.** Download a mailbox or folder as a zip of .eml or one .mbox; later, put messages back with Graph.
- **Retention.** Optionally delete files of messages deleted at the source more than N days ago (off by default).
- **Remote console** with sign-in (Entra sign-in for admins), then allow other computers.
- **Calendar and contacts** (Graph delta works for both).

## Ideas

- Encrypt stored .eml files at rest with a key outside the backup folder.
- Export a mailbox as PST for people who want Outlook to open it.
- Per-mailbox size and growth charts on the dashboard.
