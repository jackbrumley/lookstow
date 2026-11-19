# SPEC-BACKUP-INTEGRITY: A safe index, honest archive reads, and proof the backup is whole

Status: plan, approved in principle by the maintainer on 2026-11-19. No code yet.

## 1. Problem

Lookstow keeps two things: the message files on the backup drive, written once, and the index (`lookstow.db`), which is the only record of:

- which folder each message is in, and every move, delete and restore (its history);
- which messages were deleted at the source (their files stay);
- where each folder's sync got to (the delta links);
- the settings, the activity log and the sealed secrets.

Three gaps follow.

1. **The index has no regular safety copy.** The updater copies it to `<data>/backups/pre-update-<from>-to-<to>.db` before an update, and at no other time. If the file is lost or corrupted, the message files survive, but every history is gone and every mailbox is copied again from the start.
2. **An archive item the reader cannot read is read again at every start.** `archiveItemsToIndex` picks rows with an empty subject and sender and no Message-ID, so an unreadable item matches every time, and the log repeats the same warning.
3. **Nothing proves the backup is complete.** Lookstow trusts Microsoft's delta queries. Nothing compares what Microsoft holds in a folder with what the index holds.

## 2. Decisions

- **A daily snapshot of the index, onto the backup drive.** The backup drive is where an admin already looks after the mail; a copy there survives the loss of the data folder when the backup folder is on another drive.
- **Restore is a documented manual step, not a button.** AGENTS.md: the database is never replaced automatically. The admin stops the service and copies a snapshot over `lookstow.db`.
- **Rebuilding the index from the files alone is not built now** (section 5). A snapshot at most a day old is the recovery path.
- **A failed archive read is recorded with the Lookstow version that tried.** It is read again only by a newer version, whose reader may have learned the format.
- **The completeness check reports numbers before it raises alerts.** The first release shows each folder's count from Microsoft beside the index's. Alerts come once real tenants show which differences are normal (section 7, open questions).
- **`engine.ts` is split before any of this lands** (section 8), with no change in behaviour.

## 3. The index snapshot

**When.** Once a day: on the engine's tick, when the newest snapshot is more than 24 hours old and the start-up passes (refiling, archive indexing) are finished. A sync may run at the same time.

**How.** SQLite's online backup (`better-sqlite3`'s `db.backup(path)`). It copies a consistent database while Lookstow keeps writing, and it does not lock writers out for the whole copy. It writes to `<name>.partial`, then renames, so a stopped copy never looks like a snapshot.

**Where.** `<backup root>/.lookstow-index/lookstow-<yyyy-mm-dd>.db`. The folder sits inside the backup root, so it gets the backup folder's permissions (Linux 0700, the Windows DACL for SYSTEM, Administrators and LocalService). The leading dot keeps it out of the way of the mailbox folders.

**How many.** The 7 newest. After a snapshot succeeds, older `lookstow-*.db` files in that folder are deleted. That folder holds no mail, and nothing else in it is touched. This is a new delete path: `scripts/hygiene.ts`'s `FILE_CHANGE_ALLOWED` gets the new module, with this reason.

**What it holds.** Everything in the index, including sealed secrets. They are sealed with `SECRETS_KEY`, which lives in `server.env` in the data folder, never on the backup drive.

**Seen in the console.** Settings, under Backup folder: "Index snapshot: <date>, <size>. 7 kept in <path>." A failed snapshot is a warning in the activity log and on the dashboard, in plain words ("Could not copy the index to the backup drive: <reason>"). The alerts list gets "Index snapshot failed".

**Restore** (README, "If the index is lost"):

1. Stop the service.
2. Copy the newest snapshot over `<data>/lookstow.db`, and delete `lookstow.db-wal` and `lookstow.db-shm`.
3. Start the service.

Each folder's sync then resumes from the snapshot's delta links. A delta link Microsoft no longer accepts restarts that folder without downloading stored messages again (this already works). Messages stored after the snapshot are downloaded again under the same file name, which comes from the date, the subject and the message's id. So the same file is rewritten with the same message (exception 1 in AGENTS.md section 11), and nothing is duplicated. History recorded after the snapshot is lost; at most one day.

## 4. Failed archive reads

- A new nullable column, `messages.index_failed_version` (text). It is generated with `npm run db:generate`, additive, and safe for the previous release.
- When `indexFts` cannot read an item (at copy time or in the start-up pass), the row records the running version. The item stays stored as it came, as now.
- `archiveItemsToIndex` skips rows whose `index_failed_version` equals the running version. An update to a newer reader tries them once more.
- The mailbox page shows "<n> archive items could not be read for Search; they are stored as they came", and the log names each one once per version.

## 5. Rebuilding the index from the files (not now)

The files hold most of what Search needs (subject, sender, recipients, dates and Message-ID in the headers, or in the `.fts` properties), and the folder name gives the mailbox. They do not hold Microsoft's message id, the folder, or the history. A rebuild would list every file as "recovered", searchable and downloadable. A later sync would then adopt each one by Message-ID instead of downloading it again. That is a large, careful piece of work, and a daily snapshot covers the same failure with at most a day lost. Revisit if a snapshot ever proves unusable.

## 6. The completeness check

**Numbers.**

- Mailbox folders: add `totalItemCount` to the folder list Lookstow already asks for at every sync (`graph/mail.ts`, `listFolders`). It is the same request, so no extra calls.
- Archive folders: `totalItemCount` is already read (`graph/archive.ts`).
- The index: messages in that folder not marked deleted at the source.

**When.** After a folder's sync finishes with its delta up to date, store Microsoft's count and the time on the folder row (`mail_folders.source_count`, `mail_folders.source_count_at`). These are new nullable columns, generated and additive.

**Shown.**

- On the mailbox page, each folder shows "Microsoft: n, stored: m" when they differ.
- On the Mailboxes list, a "Differs from Microsoft" filter.
- On the dashboard, "<n> mailboxes differ from Microsoft".

A difference is shown as numbers, never hidden, and never "fixed" by changing a count.

**Known reasons a folder can differ.** Mail arriving between the delta and the count, and items in a mail folder that are not messages (Deleted Items can hold contacts and calendar items, which a message delta does not return). The first release reports. Alerts come after real tenants show which differences are normal.

## 7. Open questions

1. Seven daily snapshots of a large tenant's index may be several GB. Keep 7 fixed, or make it a setting?
2. When the backup folder is the default (inside the data folder), a snapshot protects against corruption but not against losing the drive. Should Settings say so?
3. Which differences should the completeness check alert on? Decide after a week of numbers from the test tenant.

## 8. Before this: split `engine.ts` (no change in behaviour)

`engine.ts` is 688 lines. It does the queue and timer, discovery passes, sync passes, and the start-up passes (refiling, archive indexing, recounting). The snapshot would add one more job. Split it by responsibility after the other session's 0.6.2 lands, since 0.6.2 also edits `engine.ts`:

- `engine/engine.ts`: lifecycle, timer, queue, cancel and wait, status.
- `engine/sync-pass.ts`: one pass, its slots and its throughput.
- `engine/discovery-pass.ts`: discovery and applying it.
- `engine/startup-tasks.ts`: refiling, archive indexing, recounting, and later the snapshot.

Every existing test passes unchanged. A refactor commit with no version bump, since nothing user-visible changes.

## 9. Security notes

- The snapshot copies the whole index to the backup drive, sealed secrets included. It stays inside the backup root's permissions, and the key never leaves the data folder.
- Pruning snapshots is a new delete path. It is limited to `lookstow-*.db` files in `.lookstow-index/`, named in `FILE_CHANGE_ALLOWED`, and tested so it can never touch a mailbox folder.
- Restore stays manual (AGENTS.md: the database is never replaced automatically).

## 10. Acceptance criteria

| #   | Criterion                                                                            | Test                                                                                      |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1   | A snapshot is written once a day, only after the start-up passes finish              | `index-snapshot.test.ts`: "takes one snapshot a day, after the start-up passes"           |
| 2   | A snapshot opens as a database with the same rows as the index                       | `index-snapshot.test.ts`: "a snapshot is a complete, consistent copy"                     |
| 3   | A stopped snapshot leaves only a `.partial` file, never a file named like a snapshot | `index-snapshot.test.ts`: "a stopped snapshot never looks finished"                       |
| 4   | Only the 7 newest snapshots stay; nothing else in the backup root is touched         | `index-snapshot.test.ts`: "keeps seven and touches nothing else"                          |
| 5   | A failed snapshot is a warning in the activity log and an alert                      | `index-snapshot.test.ts`: "a failed snapshot is reported"                                 |
| 6   | An unreadable archive item is tried once per version                                 | `fts-index.test.ts`: "an unreadable item is read again only by a newer version"           |
| 7   | Mailbox and archive folders record Microsoft's count after an up-to-date sync        | `mailbox-sync.test.ts`, `archive-sync.test.ts`: "records Microsoft's folder count"        |
| 8   | A folder whose counts differ shows both numbers                                      | `views.test.ts`: "a folder that differs from Microsoft shows both counts"                 |
| 9   | Restoring a snapshot and syncing again stores no duplicate file                      | `mailbox-sync.test.ts`: "after a restored index, newer mail is rewritten, not duplicated" |
| 10  | The engine split changes no behaviour                                                | every existing engine test passes unchanged                                               |

## 11. Releases

1. A refactor commit: the `engine.ts` split (after 0.6.2).
2. 0.7.0: the index snapshot, its Settings line and alert, the restore steps in the README, and failed archive reads.
3. 0.8.0: the completeness check, reporting only.

## 12. As built

**The `engine.ts` split** (refactor, no version). The engine keeps its lifecycle, timer, queue, slots and status. The other jobs moved out:

- `sync-pass.ts`: `syncOneMailbox`, with its run record, log lines and activity entries.
- `discovery-pass.ts`: `runDiscovery`.
- `startup-tasks.ts`: closing interrupted runs, the recount, the date-layout move, and reading older archive items.

The engine's slots stayed in `engine.ts`; moving them is the throughput work's phase 3.

**0.7.0.**

- **Snapshot.** `storage/index-snapshot.ts` takes, lists and prunes snapshots. `engine/snapshot-task.ts` records a failure. The engine (`#snapshotWhenDue`) schedules it:
  - on the tick, after the start-up passes, never onto a full drive, and while paused too;
  - an hour after a failure.

  A failure is an `error` activity entry of kind `index-snapshot`, so it shows under Recent problems, with an alert type of the same name. The dashboard shows "Index copy". Settings shows the last copy and says when the copies share the index's drive. `.partial` files a stop left behind are removed by the next snapshot.

- **Restore** is in the README ("If the index is lost") and on the new How it works page, with the computer's own folders.
- **Failed reads.** Migration `0004_archive-read-failed.sql` adds `messages.index_failed_version`. Two places set it: `indexArchiveItems` (which now takes the version) and the archive sync at copy time. `setMessageIndex` clears it. The mailbox page shows "Not readable" with the count.
- **Acceptance criteria, as tested.** 1: `snapshotDue` ("is due once a day"); the engine's guard has no unit test, because the engine has no test rig yet. 2–5: `index-snapshot.test.ts`. 6: `archive-sync.test.ts`, "reads archive items stored before 0.6.0…" (same version skips, newer version retries). 7–9: 0.8.0.
