# Spec: one email, two places (a mailbox and its online archive)

Status: **approved by Jack 2026-11-19** ("go"): link the copies, wait before calling an email deleted, keep both files. To be built after the 0.12.0 release, with migration 0010 agreed with lookstow-7e.

## 1. The problem

An archive policy moves mail older than about a year from a person's mailbox to their online archive. Today Lookstow:

1. stores the email from the mailbox (`.eml`);
2. sees it leave the mailbox, and marks it **deleted in Microsoft 365**, which is wrong;
3. finds it in the online archive as a new item with a new id, and stores it again (`.fts`), with nothing tying the two together.

So almost every email is eventually stored twice, unlinked, and the mailbox's deletion counts are mostly archive moves. A compliance reader needs "deleted" to mean deleted.

## 2. Decisions

1. **Link the two copies.** The mailbox copy records "moved to the online archive", never "deleted".
2. **Wait before calling an email deleted.** When an email leaves a mailbox that has an online archive, it is marked _left_; it becomes _archived_ when its archive copy is found, and _deleted_ only if none is found within 7 days.
3. **Keep both files.** They are independent copies of the evidence, and a difference between them would itself be worth knowing. Disk is cheap; nothing is removed. (Storing once was considered: it would halve the disk used by archived mail but lose the archive's full-fidelity copy, and saves no Microsoft traffic, since an archive item's Message-ID is only known after it is exported.)

## 3. Matching

Two messages are the same email when all of these hold:

- **Same person:** the mailbox and the online archive belong to the same user (`mailboxes.userId`; kinds `user` or `shared` and `archive`). Never across people.
- **Same Internet Message-ID**, compared without angle brackets and ignoring case. Messages without one (drafts, notes, tasks, some calendar items) are never matched.
- **Same received time**, within 5 seconds.
- If several mailbox messages still qualify (an email sent to oneself is in Sent Items and the Inbox with the same Message-ID), the one whose **folder path** equals the archive item's folder path wins; failing that, the earliest stored. Each message links to at most one other.

## 4. Data (migration 0010)

- `messages.archive_copy_id` (text, nullable, references `messages.id`, on delete set null), set on the **mailbox** copy, pointing to its archive copy. Index on it, so the archive copy can find its mailbox copy.
- `messages.left_at` (timestamp, nullable): when the email left its mailbox while that mailbox has an online archive; cleared when it is linked, comes back, or is settled as deleted.
- `message_events.kind` gains `archived` (folder from: the mailbox folder; folder to: `Online archive/<archive folder>`). Drizzle's text enum is checked in TypeScript only, so no table change.

## 5. Flow

**When an email leaves a mailbox** (`applyRemovals` in a mailbox sync):

- already linked to an archive copy → event `archived`, no `deleted_at`;
- the person has an online archive in scope → set `left_at`;
- otherwise → deleted, as today.

**When an archive item is stored** (archive sync), or read for the first time by the `.fts` index (items stored before 0.6.0): look for its mailbox copy (section 3). If found: set `archive_copy_id`, clear `left_at`, clear a `deleted_at` that an earlier version set, and record `archived` at the time it left (or now, if it has not left yet; the later removal then records nothing more).

**Settling** (at the end of each sync of a mailbox): messages with `left_at` more than 7 days ago and no archive copy become deleted, with `deleted_at = left_at` and the `deleted` event at that time.

**Coming back:** if a message with `left_at` reappears in its mailbox, `left_at` is cleared (it was moved within the mailbox, or restored from the archive).

**Once, at upgrade:** a background pass links every existing archive item to its mailbox copy, turning the old false "deleted" into "archived". It runs after the `.fts` index pass, a batch at a time, and is idempotent.

## 6. What people see

- **Mailbox page and dashboard:** deletion counts count only real deletions. Archived emails are counted separately as "moved to the online archive".
- **Message page:** "Also in the online archive" (or "Also in the mailbox") with a link to the other copy, and the `archived` event in the history.
- **Search:** an archive item linked to a mailbox copy is listed once (as the mailbox copy, marked "also in the online archive"); a tick shows both.
- **AI tools:** `get_message` adds `otherCopy: { id, mailbox, folder }`; `search_messages` lists a linked pair once unless `includeArchiveCopies` is set.
- **Completeness check:** a message with `left_at` set is not counted as being in its mailbox folder (Microsoft no longer counts it there).

## 7. Tests

- Mailbox email stored, then moved: removal sets `left_at`; archive item stored; link set, `archived` event, no `deleted_at`.
- Archive first: archive item stored before the mailbox notices; link set; later removal records nothing more.
- Sent-to-self: two mailbox copies with one Message-ID; the folder path decides.
- No Message-ID: never linked; settles as deleted after 7 days.
- Different person, same Message-ID: never linked.
- Upgrade pass: an old "deleted" pair becomes "archived"; running it twice changes nothing.
- Search, message page and AI tools show the pair once.

## 8. Files

Mailbox and archive sync (`services/engine/mailbox-sync.ts`, `archive-sync.ts`, `sync-common.ts`), `services/mailboxes/repository.ts`, `services/fts/fts-index.ts`, `services/messages/search.ts`, the AI tools, the message and mailbox pages, and a startup task. Several are in lookstow-7e's current sprint, so the work starts after that sprint lands.
