# Decisions

The technical choices and their reasons. Add to it when you make one.

## Build our own instead of more Veeam licences (2026-11-18)

Veeam's per-user licence turns "what is backed up" into a list someone keeps by hand, and gaps were found. A small service that backs up whatever discovery finds removes the list. Microsoft 365 Backup (Microsoft's own, billed per GB) was considered; it keeps the copy in Microsoft's cloud, and a copy on our own disk was the point.

## Name: Lookstow (2026-11-18)

Outlook → Look**stow** ("stow": to put away safely), in the style of SomeDrive (OneDrive). Outkeep, Inlook, SomeMail and Backlook were taken; lookstow.com and lookstow.org were unregistered.

## SvelteKit service with a local web console (2026-11-18)

The maintainer wanted a console to open, monitor and act on, like ComTap's, on Windows and Linux. A web page served by the service needs nothing else installed, works on a server with no desktop session, and handles hundreds of mailboxes in tables. Tauri was considered and not chosen: a second program to install and keep in step with the service.

## BMuster's install and update architecture (2026-11-18)

Self-update and one-line install matter most. BMuster already solves both on Windows and Linux: a Rust launcher with a pinned Node runtime, signed release manifests, versioned release folders with a `current` link, a root updater the app can only trigger, health checks and rollback. Ported rather than re-invented. Chosen over i12-pt6-control's single Node executable (Windows only, updated by hand) and ComTap's update scripts (no signatures or rollback).

## Unprivileged service, privileged updater (2026-11-18)

The service reads every mailbox, so it runs as the Linux user `lookstow` or Windows LocalService, and only the updater runs as root/SYSTEM. A compromised console can at most ask for the genuine latest signed release.

## Node 26, as BMuster (2026-11-18)

Started on Node 24 (installed on the development machine), then moved to 26 to match BMuster and to move the development machines forward. `.node-version` pins 26.13.0; the release bundles that exact build, and `engines` requires 26 or newer.

## Microsoft Graph, not EWS (2026-11-18)

EWS is being retired in Exchange Online. Graph v1.0 covers primary mailboxes (folders, delta queries, MIME). Archives need the beta mailbox API (DESIGN.md section 7).

## Certificate made by the console, RS256 assertions (2026-11-18)

Client secrets expire and can be copied; a certificate's private key never leaves the server. Node can sign but not build certificates, so the DER encoder from BMuster builds an RSA 3072 self-signed certificate. Entra accepts RSA keys only for client assertions; RS256 is accepted by every tenant.

## Plain .eml files in a readable tree (2026-11-18)

A backup should be usable without Lookstow: any mail program opens .eml, and folders mirror the mailbox. The SQLite index is for sync state and the console, not the only way to find mail.

## Immutable ids and folder-aware deletes (2026-11-18)

With `Prefer: IdType="ImmutableId"` a message keeps its id when moved. A folder's delta reports a moved message as removed, so a removal marks the message deleted only if it is still filed in that folder; the destination folder's delta files it there.

## Console on this computer only, for now (2026-11-18)

Remote access needs sign-in, and sign-in is not built. Refusing other computers is safer than a console anyone on the network can open.

## Automatic updates on by default (2026-11-18)

The maintainer wants to iterate quickly. Releases are signed and roll back by themselves, so installing a new release soon after the daily check finds it is low risk. A switch in Settings turns it off.

## Icon and colours: the mail crate, rose and amber (2026-11-18)

A letter dropping into a crate says what the app does ("stow": put away safely), and the dark body with a coloured band echoes ComTap and RawTap without copying their window shape. Rose (#e11d48) is unused in the family; amber (#f59e0b) stays a small accent, away from RawTap's amber. One SVG is the app icon, favicon and install-page icon. The nine other options are kept in `docs/design/icon-options.html`.

## Files filed by date, folders in the index (2026-11-18)

Folder-based paths meant a message moved in Outlook had to move on disk, or the tree lied. Now each file goes under `<mailbox>/<yyyy>/<mm>/` by its received date and is never moved; the folder it is in, and every move, delete and restore, live in the index as its history. Files from earlier versions are moved into the date layout once, by 0.4.3 at startup (see the next entry).

## Online archives as FTS through the beta export API (2026-11-18)

Only the beta Mailbox Import/Export API reads online archives (Graph v1.0 cannot; EWS is retiring). It exports Exchange's full-fidelity stream, not MIME. Lookstow stores that stream as it comes (`.fts`), so nothing is lost and it can be imported back; converting it to .eml is later work. It needs three more application permissions, which Microsoft asks for separately.

## Old files moved into the date layout (2026-11-19)

0.4.0 left files stored earlier under their mail-folder paths, so a backup had two layouts and the old folders still looked like mailbox folders. 0.4.3 moves them once at startup: rename (same drive, so fast, and the bytes and SHA-256 are unchanged), then record the new path, then remove the emptied folders. Syncs wait until it is done. It is safe to stop and restart: a file already at its new path only gets its row updated, and a rename never replaces a file.

## A small update archive, and no permission reset on every update (2026-11-19)

The 0.4.3 update took three minutes on Windows. Two causes. The archive held about 4,000 files, mostly two libraries' source in `node_modules`, and Windows unpacks and scans each one. And every update reset the data folder's permissions across every file inside it, including the whole backup. Now only native modules (`better-sqlite3`) ship in `node_modules`; the build bundles every other library into the app's files (380 files, unpacked in about 3 s instead of 16 s). And an update reads the data folder's own permissions and resets the tree only when they are not Lookstow's; an install still always resets it.

## Alert email through Mailgun, from the activity log (2026-11-19)

Alerts were planned over SMTP; i12-pt6-control already sends through Mailgun's HTTP API with a sending domain Midfield has, so Lookstow does the same: no mail server to configure, one key, and a clear refusal message when something is wrong. The key is sealed like the Graph secret and goes only to Mailgun's API host for the chosen region, fixed in code. Alerts follow the activity log (a listener on `recordActivity`) instead of each part of Lookstow sending email, so every alert is also an activity entry, and adding an alert is one rule in `alert-rules.ts`. The outbox and its retry schedule are i12-pt6-control's.

## Graph JSON with raw control characters is accepted (2026-11-19)

The mailbox export API answered with JSON holding raw control characters inside strings, which strict JSON forbids, and the same reply came back on every try, so an online archive stopped at that batch for good. `parseGraphJson` (graph/client.ts) escapes such characters inside strings only, so every value keeps its exact text; any other fault in a reply still fails.

## Lookstow reads online archive items itself (2026-11-19)

Archive items come only as Exchange's full-fidelity export, which no mail program opens and Search could not see into. Real exports from the tenant showed the format: a list of records whose type 2 parts hold a FastTransfer stream (MS-OXCFXICS) of the item's properties, recipients and attachments, with attached messages nested. Lookstow reads it with its own strict reader (no dependency), indexes each item like normal mail, and turns an item into an `.eml` (HTML or text body, inline images, attachments, attached messages as `message/rfc822`) when asked. The `.fts` file stays the stored record, unchanged; the `.eml` is a readable copy made from it. New items are filed by the date they were received, read from the item, not the date they moved into the archive.

## Stricter checks: hygiene, knip, no type assertions, clippy pedantic (2026-11-19)

AGENTS.md states many rules that no tool enforced, so an agent could break them and stay green. `scripts/hygiene.ts` now checks the structural ones (file size, boundaries, the files allowed to delete or move on disk, where Microsoft's hosts are named), and knip finds unused code and import cycles; both run in `npm run verify`. ESLint now refuses every type assertion except `as const`, tsconfig adds unused locals and parameters and unchecked side-effect imports, and the launcher denies clippy's `pedantic` group. The idea came from Midfield AI's hygiene script, rewritten for Lookstow's rules rather than copied.

## Delete covers every mailbox that is not backed up; counts come from the stored messages (2026-11-19)

What is backed up offered Delete only for mailboxes leaving in that save. A mailbox left out earlier with Keep could never be deleted from there, and choosing Delete later did nothing without saying so. Delete now means: the backup drive holds only what is backed up. And a mailbox's item count was written only when a sync finished, so a first copy stopped part-way showed 0 and its backup was invisible to every delete path. The stored messages are now the one record of what a mailbox holds: storing a message raises its count in the same transaction, deleting a backup clears it, and start-up corrects any count left wrong.

## Archive items filed by their received date (2026-11-19)

The export API dates an archive item by when it moved into the archive, often two years after it was received, so archive folders did not match the mailbox's own. From 0.6.0 new items are filed by the received date read from the item; items copied earlier are moved once, after the start-up indexing has read their received date, through the same safe move as the 0.4.3 relayout (`moveStoredFiles`): a rename on the same drive, never replacing a file, the new path recorded. An item whose received date is unknown keeps its place.

## A daily index snapshot on the backup drive (2026-11-19)

The index is the only record of each message's folder history, the deletions at the source and every folder's sync position, and it was copied only before an update. Now SQLite's online backup copies it once a day to `.lookstow-index` in the backup folder, and the newest 7 are kept. That is the backup drive, because an admin already looks after it, and it survives the data folder when the backup folder is on another drive. Restoring stays a manual step: the database is never replaced automatically. Rebuilding the index from the files alone was left out: the files do not hold Microsoft's ids, the folders or the history, and a day-old copy covers the same failure (SPEC-BACKUP-INTEGRITY.md section 5).

## The completeness check reports before it alerts (2026-11-19)

Lookstow trusted Microsoft's delta queries and could not prove a backup was whole. Now every up-to-date folder sync records Microsoft's `totalItemCount`, taken from the folder list it already asks for (no extra requests), and pages compare it with the stored messages. It only reports for now. Some differences are normal: mail arriving between the folder list and the delta, and items that are not messages in mail folders. An alert that fires on those would be ignored, so alerts wait for real numbers.

## A throughput governor between Lookstow and Microsoft (2026-11-19)

Copying was limited by how requests were issued, not by Microsoft: one export request at a time per archive, every throttled request sleeping on its own, and nothing learned between restarts. Every Graph request now asks one governor (graph/governor.ts) for a permit, after SomeDrive's adaptive limit: a lane per mailbox (Microsoft allows about 4 requests at once per mailbox), an app-wide pace that climbs while it is what holds work back, is cut once per throttle burst to 85% of the refused pace, holds 30 minutes and then probes, and a shared wait (Retry-After) per scope with one probe before the rest resume. The learned pace is kept between restarts. Its numbers are shown on the dashboard and at /api/throughput, and sampled every 10 s into a 7-day history, with no addresses, names or ids. Plan and later phases: docs/specs/SPEC-THROUGHPUT.md.

## The governor settles at 90%, saves no burst, and decides mailboxes at once (2026-11-19)

Run against a simulated Microsoft (tests/support/simulated-microsoft.ts), the 0.9.0 governor was cut five times in a row after its first refusal and settled at 44% of the limit: its token bucket saved a full second of starts during Microsoft's wait and released them at once. The bucket now holds a tenth of a second (at least 2) and earns nothing during a wait. Settling at 90% of the refused pace instead of 85% holds 91–94% of the limit with one refusal a cycle; a refusal costs one short wait, so sitting closer is cheap. Mailboxes at once now follow the governor's headroom (MailboxSlots) instead of counting throttled replies, and the default maximum is 32. Large items limited to a share of a lane were left out: a mail delta does not give a message's size.

## AI tools read the backup over MCP, from the server only (2026-11-19)

A compliance review (handwritten timesheets photographed and emailed to payroll years ago) needs an AI agent to search the backup, read messages and look at attachments. Lookstow serves the Model Context Protocol itself at /mcp (Streamable HTTP, JSON replies), so Claude Code on the server connects with one command and needs no extra program. It answers only on the server, only when turned on in Settings, and only with an access token of which only the SHA-256 is kept. The tools only read; tagging and findings live outside Lookstow (a CSV kept by the agent), keyed by message id, attachment index and SHA-256, so the backup stays untouched evidence. Every call is written to an audit log. Messages are read by a small MIME reader in Lookstow rather than a new dependency. Not built yet: searching message bodies, and filtering by attachment, which need an index of message content.

## A mailbox's throttling slows only that mailbox; learned limits expire (2026-11-19)

On the tenant the governor held the whole app at 2.84 requests a second, learned two hours earlier, while one mailbox had 16 requests waiting. Outlook reports a mailbox's own limit as `ApplicationThrottled` with "MailboxConcurrency" only in the message, and the client read only the code, so every such refusal (and every 503 and early warning on a mailbox's request) cut the app-wide pace, which was then kept across restarts. Now any throttle on a request about a mailbox lowers only that mailbox's lane (Outlook's limits are per app per mailbox; a true app-wide limit would show on every lane and slow each), early warnings on a mailbox's request do not ease the app pace, and a learned limit is forgotten after 6 hours without a new refusal (a saved pace below the first-run pace starts from the first-run pace). The Speed card shows Idle when nothing is being copied, instead of "At the learned limit, probing".

## 2026-11-19: One live status for every page

The side bar, the dashboard, the Speed card and the Mailboxes pages each read the engine at their own moment, and the side bar never refreshed outside the dashboard. Now the root layout's load builds one snapshot (`liveStatus()`), every page that shows live state reads it, and the layout refreshes it on a timer for every page. A snapshot that contradicts itself is logged. Polling was kept over a push stream: it already worked, survives restarts and updates, and a few seconds' delay does not matter. `docs/specs/SPEC-STATUS.md`.

## 2026-11-19: Completeness repairs itself

The completeness check read Microsoft's counts before a sync and compared them with what was stored after it, so mail arriving or leaving during the sync showed as a difference. It also could not tell a real gap from items waiting to be copied again, or from items in a mail folder that are not messages. Now the counts are read after the folders sync. Items waiting to be copied again, and the items that are not messages (measured by the last full listing of the folder), explain a higher count. A gap nothing explains for half an hour makes the next sync read that folder again from the start, at most once a day, using the same path as an expired delta link: nothing already stored is downloaded again and no file is touched. A gap that lasts a day after a re-read is an error in the activity log, once, with its own alert. Four nullable columns on `mail_folders` hold the state (migrations 0008 and 0009). `docs/specs/SPEC-COMPLETENESS-REPAIR.md`.

## 2026-11-19: Moving the backup folder

Changing the backup folder used to save a path and leave the files to be moved by hand. A partial move left the index pointing at files that were gone, and a backup drive that was not attached got a new backup started on the system drive. Now the backup folder carries a marker, `.lookstow-backup`, with an id the index keeps. A folder without it that does not hold the stored mail stops every write. Moving is done by the app, in lockdown: an administrator first prepares the new folder with `lookstow backup-folder prepare` (the service cannot grant itself rights, and on Linux its unit must name the folder, which a systemd drop-in does). The app then copies every file, checks each copy against the index's SHA-256, and switches only when the whole copy is checked. It is resumable after a restart. Only the backup folder moves: the index stays in the data folder, where the updater copies it before each update. The old copy stays until REMOVE is typed, and removal deletes a file only when its copy is identical. This is the fourth exception to "written once" (AGENTS.md section 11). Change is offered only while nothing is stored. `docs/specs/SPEC-BACKUP-FOLDER-MOVE.md`.

## 2026-11-20: A work thread, a content file and an indexed search

With five mailboxes the console took seconds a page and the update check timed out: everything ran on one thread, and an AI sweep's searches each read the whole 900 MB content index. The backup engine, email alerts, the throughput monitor, the indexes and the AI tools now run on a second thread in the same service, which sends the console a snapshot every second. A second thread rather than a second service: one install, one update, one rollback, and both halves always the same version. What Lookstow can rebuild (an FTS5 trigram index over subjects and addresses, and the AI tools' message text with a word index) moved to its own file, lookstow-content.db, so the main index and its copies stay small; the 0.12 content table is moved over without reading messages again. Search uses the index when it narrows a search to 5,000 messages or fewer and otherwise walks newest first; results are checked for the exact text, so they match what LIKE found. Slow queries, held threads and slow requests are logged and shown at /api/throughput. `docs/specs/SPEC-SCALE.md`.

## 2026-11-20: The dashboard shows lasting facts apart from what is happening now

"Waiting for first copy" added the mailboxes syncing right now to those never copied, so it rose with every sync round, and "Backed up 2 of 1,817" counted every mailbox in the tenant. The tiles are now facts that change only when something really changes: mailboxes in the backup, fully copied (from a mailbox's first complete copy on, whether it is syncing or its last sync failed), first copies in progress with their folders, needs attention (a failed last sync, or a folder that still differs a day after a re-read) and stored. What is happening now is one sentence and the Now table, archives labelled. Errors about a mailbox that still needs attention show with it; earlier ones are collapsed as cleared. Discovery, the index copy, completeness checks, the drive, the queue and the Speed card are collapsed under details. The AI tools moved to their own thread at the same time, so an agent's searches never hold the backup engine.

## 2026-11-23: Auto-expanding archives, Recoverable Items and update reminders

A review found Sarah Croft's online archive "needing a look" in 60 folders that Microsoft counted as empty, while Lookstow held their mail. Exchange's own statistics (Get-MailboxFolderStatistics -Archive) matched Lookstow folder for folder: the tenant has auto-expanding archives on, her archive has three auxiliary parts, and Graph's folder count covers only the part a folder is listed in. So an archive folder whose full listing returns more than Graph counts is checked against that listing (kept, and repeated every week) instead of Graph's count; items a full listing no longer returns are recorded as deleted at the source (files kept), unless the listing returned far fewer than stored, which is logged instead. A mail re-read now also records as deleted a message Microsoft still finds by id but in a folder Lookstow does not copy (Shift+Delete puts it in Recoverable Items). Recoverable Items and the items in a mailbox's or archive's root, which the folder tree leaves out, are an opt-in in Settings: Graph's support for them varies by mailbox, so each is tried on its own and a refusal is logged, never failing the sync or holding up a first copy. Three indexes take the slowest queries (the "left a week ago" check after every sync, per-folder counts, unreadable items) from seconds to milliseconds. A new release is looked for every 6 hours and at every start, and every page shows it in a modal until someone answers: Update now, Remind me tomorrow, or Skip this version, kept on the server.

## 2026-11-23: Read-only remote access with local accounts, and a message viewer

The compliance review's report links to messages in Lookstow, and its readers sit at other computers. Remote access is a second, HTTPS listener (self-signed certificate made by the app, its key sealed), on only when turned on in Settings. A request gets in only from an allow-listed address, signed in with a local account (scrypt hashes, in-memory sessions, a lockout after five wrong passwords), and only to read: the dashboard, mailboxes, Search and messages. Every remote request is written to an audit trail. Local accounts rather than Entra sign-in, at the maintainer's choice: a handful of people, no app registration changes. The plain-HTTP console stays local-only. A message now opens in the browser: its body in a sandboxed frame that runs nothing, with its own pictures written in and pictures from the internet only on request, and pictures, PDFs and text attachments shown inline. HEIC photos only download until a converter library is approved. `docs/specs/SPEC-REMOTE.md`, `docs/specs/SPEC-VIEWER.md`.

## 2026-11-23: Evidence packs

Messages sometimes have to go to a lawyer, thousands at a time and several gigabytes, on a memory stick. An evidence pack is one ZIP of chosen messages, each .eml exactly as stored and checked against the SHA-256 recorded when it was backed up, with a manifest, an index page, a README and every file's SHA-256; the ZIP's own SHA-256 is shown and logged. Ids are pasted on a page, or sent by an AI agent through MCP tools, which also follow the pack and give a download URL that takes the access token. Packs are made on the reading thread, one at a time, kept as files in the data folder (no table), and removed after 7 days. One file, not split parts: a FAT32 stick can be formatted exFAT. The ZIP writer is Lookstow's own (ZIP64 when needed, on Node's zlib) rather than a new dependency. Remote accounts make packs only when given the right. `docs/specs/SPEC-EVIDENCE-PACKS.md`.
