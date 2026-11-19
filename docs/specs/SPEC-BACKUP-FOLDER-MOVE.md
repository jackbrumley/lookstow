# Spec: moving the backup to another folder

## 1. Problem

The backup starts in the data folder (`C:\ProgramData\Lookstow\mailboxes`, `/var/lib/lookstow/mailboxes`), usually on the system drive. Admins want it on its own drive. Until now, Settings > Backup folder > Change saved a new path and said to move the files by hand. That was unsafe in several ways:

- The index finds each stored message by its path under the backup folder. If the path changed and not every file moved, downloads failed, new mail went to the new folder, and old mail was never copied again, because the index already counted it as stored.
- The service cannot write a folder outside the data folder. It runs unprivileged, and on Linux its unit allows writes only to the data folder.
- If the backup drive was not attached, or a mount did not come up, Lookstow created the folder again on the wrong disk and started a new backup there.

## 2. Decisions (approved 2026-11-19)

1. Only the backup folder moves. The index (`lookstow.db`) stays in the data folder.
2. An administrator prepares the new folder with a launcher command. The console never gains rights it does not have.
3. The app moves the backup itself, in lockdown, and checks every copy against the index's SHA-256.
4. The old copy is kept until the admin types REMOVE.
5. Change is offered only while nothing is stored. Once mail is stored, Move is the only way to another folder.

## 3. Design

### B1. The backup folder's marker

`storage/backup-marker.ts` writes a file, `.lookstow-backup`, at the top of the backup folder. It holds an id that the index also keeps (settings `backupMarker`). Before anything is written, the engine checks the folder on every tick (`engine/backup-folder-check.ts`):

- **The marker matches:** go on.
- **No marker, and nothing is stored yet:** mark the folder, creating it if it is missing.
- **No marker, but the folder holds the newest stored file:** mark it. This covers a backup folder from before markers.
- **No marker and no stored file, or no folder at all:** refuse. The status bar shows the reason ("If it is on a drive that is not attached, attach it"). No sync, index copy or move starts, and running syncs stop after their page.
- **Another backup's marker, or a marker that cannot be read:** refuse.

### B2. `lookstow backup-folder prepare <dir>`

This is a launcher command, run as root or Administrator (`launcher/crates/lookstow/src/backup_folder.rs`; `SPEC-INSTALL-AND-UPDATES.md` section 5). It creates the folder, or takes an empty one.

- **Windows:** gives the folder the data folder's protected DACL.
- **Linux:** gives the folder to the `lookstow` user at 0700. Adds it to `ReadWritePaths` in the drop-in `/etc/systemd/system/lookstow.service.d/backup-folder.conf`, then restarts a running service.

It refuses:

- links and files;
- a non-empty folder, because its permissions would be reset;
- the top of a drive;
- the program folder, and any folder that holds the data folder;
- on Linux, the folders the unit hides from the service.

### B3. Move, in lockdown

Settings > Backup folder > Move takes the prepared folder's path. `engine/backup-move-task.ts` (`BackupMover`) checks it (`moveTargetProblem`):

- it is a full path and not the backup folder itself;
- it is not inside the backup folder, and the backup folder is not inside it;
- it exists and is a folder;
- it is empty, or holds an earlier try at this same move (the same marker);
- the service can write to it;
- it has room for the index's bytes plus 2 GB.

It then saves `backupMove = moving` and runs the move:

1. **Lockdown.** While `moving`, nothing that writes to the backup starts:
   - no sync, discovery or index copy;
   - no automatic update or Update now;
   - no backup deletion, either per mailbox or in What is backed up;
   - no change to What is backed up.

   Running syncs stop after their page, and the move waits for them. A banner on every page and the side bar say so.

2. **Copy.** `storage/backup-move.ts` `copyBackup` walks the old folder in a fixed order. That includes the marker and `.lookstow-index`. For each file it:
   - copies it to `<name>.lookstow-copy`, hashing what it reads;
   - syncs the copy to disk and reads it back;
   - compares the result with what was read;
   - renames it into place.

   A source file that differs from the index's SHA-256 is still copied, and named in the activity log. A copy that differs from what was read stops the move, because the new drive is not to be trusted. A copy already in place with the right contents is kept, so a restart carries on where it was.

3. **Check and switch.** Every path the index holds must be in the new folder; any that is not is named. Then the backup folder setting changes to the new folder and the state becomes `moved`. From that moment, syncs write there.
4. **Restart and stop.** If the service stops, the move stops after the current file and carries on at the next start. Stop the move sets the state back to `none` and keeps the backup where it was. Files copied so far stay in the new folder, and a later move there carries on from them.

### B4. Remove the old copy

While the state is `moved`, Settings offers "Remove the old copy" behind a typed REMOVE, checked on the server. `removeOldCopy` deletes each old file only when the file of the same name in the new folder has the same SHA-256. Every other file is kept and named in the activity log. Empty folders go last. When nothing is kept, the state returns to `none`; otherwise it stays `moved`, so the removal can be run again.

This is the fourth exception to "written once" in AGENTS.md section 11. Copying never touches an original. Removing deletes only files that have an identical copy, and only after REMOVE is typed. Every step is recorded in the activity log (kind `backup-move`).

### B0. Change only while nothing is stored

The Change action refuses once any message is stored, or while a move is under way or its old copy is kept. Its dialog says to use Move instead.

## 4. Acceptance criteria

| #   | Criterion                                                                                                  | Test                                                                                             |
| :-- | :--------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| 1   | A new folder, and a folder from before markers that holds its mail, are marked                             | `backup-marker.test.ts` "a new backup folder is marked", "a folder from before markers"          |
| 2   | A missing folder, another backup's folder or an unreadable marker stops the backup                         | `backup-marker.test.ts` "a backup folder that is not there", "another backup's folder"           |
| 3   | A marker is never overwritten                                                                              | `backup-marker.test.ts` "never overwrites a marker"                                              |
| 4   | A folder that is missing, inside the backup, not empty or too small is refused; an earlier try is taken    | `backup-move.test.ts` "choosing the folder to move to"                                           |
| 5   | Every file, the marker and the index snapshots are copied and checked; the old copy is untouched           | `backup-move.test.ts` "copies every file"                                                        |
| 6   | A copy stopped half way and started again loses and duplicates nothing                                     | `backup-move.test.ts` "stopped half way and started again"                                       |
| 7   | A file that differs from the index is copied and named                                                     | `backup-move.test.ts` "a file that differs from the index"                                       |
| 8   | The move switches the backup folder only after the copy is checked; the new folder passes the marker check | `backup-move-task.test.ts` "copies, checks and switches"                                         |
| 9   | A move carries on after a restart; a stopping service never switches half way                              | `backup-move-task.test.ts` "carries on after a restart", "stopping the service"                  |
| 10  | Stop the move keeps the backup where it was                                                                | `backup-move-task.test.ts` "Stop the move"                                                       |
| 11  | No backup can be deleted during the move                                                                   | `backup-move-task.test.ts` "no backup can be deleted while the move runs"                        |
| 12  | The old copy is removed only file by file where the copy is identical; the rest is kept and named          | `backup-move.test.ts` "removing the old copy"; `backup-move-task.test.ts` "removes the old copy" |
| 13  | `prepare` refuses relative paths, `..`, the program and data folders, links, files and non-empty folders   | `backup_folder.rs` tests                                                                         |
| 14  | On Linux the drop-in keeps every prepared folder once, and hidden folders are refused                      | `backup_folder.rs` "the_drop_in_keeps_every_prepared_folder_once", "folders_the_unit_hides"      |
| 15  | The side bar and a banner show the move; no sync runs while files are copied                               | `live-status.ts` `statusContradictions`, `live-status.test.ts`                                   |

## 5. Not yet run

- `prepare` as root on a real systemd host, and as Administrator on a real Windows service.
- A move of a real backup of tens of GB.

The tests cover the logic with real files in temporary folders. The first real move should be watched in the console and the activity log.
