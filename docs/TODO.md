# To do

The first real run (0.1.0, 18 November 2026: 1,816 mailboxes in 1,770 users, archives found) showed what Lookstow needs next. Each phase is one release.

## Done

- **0.2, control and safety** (18 November 2026): Pause / Resume everywhere and per mailbox, disk guard, keep-or-delete on scope changes, per-mailbox scheduling.
- **0.3, visibility and throughput** (18 November 2026): live rates and throttling, discovery progress, Log page, adaptive parallel mailboxes, Mailboxes sorting and paging, Activity paging. Left out: an optional bandwidth cap, and an estimated time left for first copies.

- **0.4, archives and find mail** (18 November 2026): online archives copied (FTS through the beta export API), date-based file layout with folder history, Search with a message page and download, To/Cc recorded. Left out: message bodies in search, a readable view of archive items.

## Now: 0.5, email alerts, the update popup and faster updates

- **Email settings, as in i12-pt6-control.** SMTP host, port, TLS, user and password (sealed), sender address, and Send a test email. Recipients each choose their alerts: a mailbox failing for N hours, discovery failing, disk at 85% / 90%, a first copy finished, a mailbox gone from Microsoft 365, an update installed or failed, and a daily summary. Sent through an outbox with retries.
- **Update popup.** A dismissable dialog in the middle of the screen when a newer release waits: Update now or Later. Comes back after 24 hours (per browser). With automatic updates on, it says when the update will install.

- **Faster updates.** Let the service start the update task itself, so an update starts at once instead of within two minutes; show download and unpack progress; a smaller bundle.

## Then: 0.6, read archives and mail

- **Archive items as .eml.** Convert the stored FTS to MIME (or ask Graph for it), so archive items open in mail programs and are searchable by subject and sender.
- **Message view.** Plain-text body and attachment list on the message page; optionally body search (SQLite FTS5).

## Later

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
