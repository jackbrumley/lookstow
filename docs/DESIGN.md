# Lookstow: design

Why Lookstow exists, how it works, and what is still open. For conventions see `AGENTS.md`; for each technical choice and its reason, `decisions.md`; for install and updates, `specs/SPEC-INSTALL-AND-UPDATES.md`.

## 1. The problem

Microsoft 365 mail was backed up with Veeam. Veeam is licensed per user, so the licence count decided what was protected: inclusion and exclusion lists picked which mailboxes to back up, and mailboxes people assumed were backed up sometimes weren't. Buying more licences is possible, but the list still has to be kept by hand.

Lookstow's goal: **every active mailbox is backed up without anyone choosing it**, including shared mailboxes and online archives. When a licence is removed or a user deleted, the backup stays.

## 2. What it is

- A service on one Windows or Linux server, with a web console at `http://localhost:8030` on that server.
- It signs in to Microsoft Graph as an app (no user), finds every mailbox by itself, and copies each one into a folder as `.eml` files.
- One-line install, and it updates itself from signed releases, with automatic rollback.
- Open source (AGPL-3.0) in the same family as ComTap, RawTap, SomeDrive and BMuster.

## 3. How a mailbox is backed up

1. **Discovery** (every 6 hours, or Discover now) lists the tenant's users. A user with a mail address and an Exchange Online mailbox becomes a mailbox row; `mailboxSettings.userPurpose` says whether it is a person's, shared, a room or equipment. With archives on, the beta `settings/exchange` resource gives the online archive's id. New mailboxes start their first copy straight away; mailboxes discovery no longer finds are marked gone and keep their backup.
2. **Sync** (every 15 minutes, or Sync now) lists the mailbox's folders, then runs each folder's **delta query**: the first time it returns every message; after that only what changed. New messages are fetched as MIME (`/messages/{id}/$value`), exactly as Exchange holds them with attachments, and written as `.eml`.
3. **Storage:** `<backup folder>/<address>/<yyyy>/<mm>/<date>_<time>_<subject>_<id>.eml`, filed by the date received. A file is written once and never moved. Names are made safe for Windows and Linux. A SQLite index records each message's id, folder, sender, recipients, file, size and SHA-256. Files stored before 0.4 keep their old folder-based paths.
4. **Deletions and moves** at the source change the index, not the file, and each is recorded as the message's history (stored, moved, deleted, restored). A move between folders in one sync is recorded as a move (immutable ids).
5. **Online archives** go through the beta Mailbox Import/Export API (`/beta/admin/exchange/mailboxes/{id}`): folder list, a delta per folder, and `exportItems` in batches of 20. Items are stored as Exchange's full-fidelity export (`.fts`) under `<address> (archive)/<yyyy>/<mm>/`. Auxiliary archives are followed through `parentMailboxUrl` and the moved-item redirects. An item that fails to export keeps the folder's place, so the next sync tries it again.
6. **Search** (the Search page) queries the index: words in the subject, sender and recipients, plus sender, To/Cc, subject, folder, Message-ID, dates and mailbox. Message bodies are not indexed. Archive items have no subject or addresses until a converter exists.
7. **Resilience:** progress is saved after every page of a delta query, so a stop or crash in the middle of a large first copy loses one page at most. Throttling (429) is retried with Retry-After. An expired delta link restarts the folder without downloading again.

## 4. Security

- **Credential:** an RSA certificate the console makes. Only the certificate goes to Entra; the private key is sealed (AES-256-GCM, `SECRETS_KEY` from `server.env`) in the database. A client secret works for a first test.
- **Permissions:** `User.Read.All`, `Mail.Read`, `MailboxSettings.Read` as application permissions read every mailbox. Online archives also need `MailboxFolder.Read.All`, `MailboxItem.Read.All` and `MailboxItem.Export.All`. To scope Lookstow to some mailboxes, use Exchange Online's RBAC for Applications.
- **Console:** answers on this computer only. Writes must come from its own pages (Origin check).
- **Service account:** unprivileged (Linux user `lookstow`, Windows LocalService). Only the updater runs as root/SYSTEM, and the web app can only ask it for an update by creating a flag file. Releases are signed with an Ed25519 key kept offline.
- **At rest:** the data folder is locked to the service account and administrators. The backup folder holds every mailbox: keep it on an encrypted disk and limit who can open it.

## 5. Install and updates

Ported from BMuster (see the spec). One archive per platform: the Rust launcher, a pinned Node 26 and the app. `install` sets up the service; `run` starts Node; the root updater, started by a flag file (systemd path unit, or a SYSTEM scheduled task every two minutes on Windows), downloads the latest signed release, checks it, switches `current`, waits for the new version to report ready, and rolls back if it doesn't. The console's Updates page shows releases and progress; with automatic updates on, Lookstow asks for a new release by itself.

## 6. What is built

| Area                                                       | State                                                                                  |
| :--------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| Sign-in with certificate or secret, connection test        | Built, tested against a fake Graph and a real Entra endpoint (refusal path)            |
| Discovery of users, shared, rooms, archives                | Built, tested against a fake Graph                                                     |
| Delta sync of primary mailboxes to .eml                    | Built, tested against a fake Graph (paging, moves, deletions, expiry, stop and resume) |
| Console: dashboard, mailboxes, activity, settings, updates | Built, rendered from a production build                                                |
| Launcher, installer, root updater (Windows + Linux)        | Ported from BMuster, unit and scratch tests pass; real root/SYSTEM runs untested       |
| Installers, release workflow, signing                      | See the release agent's notes in `RELEASE.md`                                          |
| Online archive copy                                        | Built (FTS export), tested against a fake Graph; real tenant untested                  |
| Search, message page, download                             | Built, tested on the index; rendered from a production build                           |
| Restore                                                    | **Not built**: the .eml files open in any mail program                                 |
| Remote console with sign-in                                | **Not built**                                                                          |

## 7. Open risks

1. **Online archives.** Graph v1.0 cannot read archive mailboxes, so archives use a beta API, which Microsoft can change. Items are FTS, not MIME: complete and importable into a mailbox through Graph, but no mail program opens them. A converter to .eml is still to come. EWS is being retired in Exchange Online, so it is not an option.
2. **First copy of large mailboxes.** Throttling limits each mailbox to about 4 concurrent requests. A 50 GB mailbox can take a day or more. Measure on a real large mailbox.
3. **Proving completeness.** The dashboard shows each mailbox's state; a periodic check comparing Graph's folder item counts with the index would catch silent gaps.
4. **The beta discovery call** (`settings/exchange`, property `inPlaceArchiveMailboxId`) works on Midfield's tenant (verified 18 November 2026).
