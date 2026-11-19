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
