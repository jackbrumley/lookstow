# To do

The first real run (0.1.0, 18 November 2026: 1,816 mailboxes in 1,770 users, archives found) showed what Lookstow needs next. Each phase is one release.

## Done

- **0.2, control and safety** (18 November 2026): Pause / Resume everywhere and per mailbox, disk guard, keep-or-delete on scope changes, per-mailbox scheduling.
- **0.3, visibility and throughput** (18 November 2026): live rates and throttling, discovery progress, Log page, adaptive parallel mailboxes, Mailboxes sorting and paging, Activity paging. Left out: an optional bandwidth cap, and an estimated time left for first copies.

- **0.4.1–0.4.4** (19 November 2026): retries for broken replies, the archive permission check, an updater that starts at once on Windows with step times, old files moved into the date layout, a type-to-filter mailbox field in Search, a 380-file update archive, and no permission reset across the backup on each update.
- **0.4, archives and find mail** (18 November 2026): online archives copied (FTS through the beta export API), date-based file layout with folder history, Search with a message page and download, To/Cc recorded. Left out: message bodies in search, a readable view of archive items.

## Now: throughput governor (docs/specs/SPEC-THROUGHPUT.md)

- **Phase 1, done in 0.9.0:** the governor (mailbox lanes, adaptive app pace, shared throttle windows), time limits and a stalled-download watchdog, one sign-in at a time, Retry-After in every form, parallel archive exports in a memory budget, /api/throughput, the pace history and the dashboard Speed card.
- **Phase 2, done in 0.10.0:** three folders at once with the next page fetched early, streaming writes with hashing, one bad message never stops a folder (item_failures, migration 0006), deletions checked after a delta restart. Not built: large items limited to a share of a lane (a mail delta gives no size).
- **Phase 3, done in 0.10.0:** mailboxes at once driven by the governor's headroom (MailboxSlots replaces AdaptiveSlots), default maximum 32, Settings > Speed (Forget what was learned), back-off and kinds of failure for a failing mailbox.
- **Phase 4:** done in 0.10.0: the simulated Microsoft, the acceptance tests and scripts/throughput-bench.ts (they found and fixed a cut-after-cut cascade). Still to do: tuning on the tenant from the pace history.

## Then: 0.5, email alerts and the update popup

- **Email alerts.** Done in 0.5.0, as in i12-pt6-control: Mailgun, people who each choose their alerts, an outbox with retries, test emails, the Alerts page. Next: a disk warning at 85% (only the 90% pause alerts now), the result of an update (installed, rolled back, failed), and a daily summary.
- **Update popup.** A dismissable dialog in the middle of the screen when a newer release waits: Update now or Later. Comes back after 24 hours (per browser). With automatic updates on, it says when the update will install.

- **Faster updates.** Done in 0.4.2: the update task starts at once on Windows, and the Updates page shows how long each step took. Next: from those times, shrink the slow steps (a smaller bundle, a faster database backup).

## Then: 0.6, read archives and mail

- **Archive items as .eml.** Done in 0.6.0: Lookstow reads `.fts` files, indexes archive items for Search, and downloads them as `.eml`. Archive items copied before 0.6.0 are filed by their received date once they are indexed. Next: a live item count during a long first copy.
- **Message view.** Plain-text body and attachment list on the message page; optionally body search (SQLite FTS5).

## Next: 0.7 and 0.8, backup integrity (docs/specs/SPEC-BACKUP-INTEGRITY.md)

- **Split engine.ts.** Done (refactor, no version).
- **0.7: index snapshot.** Done in 0.7.0: a daily copy of the index on the backup drive (7 kept), a documented restore, a How it works page, and archive items that cannot be read are tried once per version.
- **0.8: completeness check.** Done in 0.8.0: each folder's item count from Microsoft beside the index's, on the mailbox page, a Mailboxes filter and the dashboard. Next: alerts, once a week of real numbers shows which differences are normal.

## Later

- **Backup folder outside the data folder.** The Linux unit only lets the service write `/var/lib/lookstow`, and LocalService can only write folders it is granted: the installer grants a chosen folder (`--backup-dir`).
- **Restore.** Download a mailbox or folder as a zip of .eml or one .mbox; later, put messages back with Graph.
- **Retention.** Optionally delete files of messages deleted at the source more than N days ago (off by default).
- **Remote console** with sign-in (Entra sign-in for admins), then allow other computers.
- **Calendar and contacts** (Graph delta works for both).

## Ideas

- Encrypt stored .eml files at rest with a key outside the backup folder.
- Export a mailbox as PST for people who want Outlook to open it.
- Per-mailbox size and growth charts on the dashboard.
