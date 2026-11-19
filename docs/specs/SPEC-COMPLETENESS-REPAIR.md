# Spec: completeness repairs itself

## 1. Problem

The completeness check (0.8.0, `SPEC-BACKUP-INTEGRITY.md`) compares each folder's stored messages with Microsoft's item count. On a real tenant it flagged mailboxes that had nothing wrong with them:

- The count was read when the sync started and compared with what was stored when it ended. Mail that arrived or left during the sync showed as a difference.
- Items that failed to copy, and are waiting for another try, showed as a gap with no reason given.
- Items in a mail folder that are not messages (Deleted Items can hold contacts and calendar items) are in Microsoft's count but never in a message listing.

An admin had no way to tell these from a real gap, and Lookstow did nothing about a real gap except show it.

## 2. Design

All of it lives in `services/mailboxes/completeness.ts`.

1. **Counts after the sync.** `syncMailbox` and `syncArchive` read the folder list again after their folders sync and save each up-to-date folder's count (`recordFolderCounts`). It costs one folder listing per sync.
2. **Explained gaps.** `explainGap(stored, source, failures, otherItems)` returns one of:
   - `unchecked`: no count yet.
   - `match`.
   - `explained`: Microsoft's count is higher by no more than the items waiting to be copied again, plus those given up after five tries (`item_failures`), plus the items that are not messages.
   - `unexplained`.

   A mailbox "differs from Microsoft" only for an unexplained gap. A stored count above Microsoft's is never explained.

3. **Items that are not messages** are measured, not guessed. When a sync lists a folder from the start (a re-read, or an expired delta link), the number of items the listing returned is kept beside the count: `mail_folders.other_item_count = count - listed`.
4. **Re-read from the start.** `mail_folders.differs_since` is set when a folder's gap is first unexplained and cleared when it is explained or matches. Once it is at least 30 minutes old (`RECHECK_AFTER_MS`, about two routine syncs), the next sync reads that folder from the start (`recheckDue`, `startRecheck`). That uses the expired-delta path: stored messages are recognised and not downloaded again, and missing ones are copied. For mail, stored messages the listing no longer returns are checked one by one and recorded as deleted at the source. A folder is re-read at most once a day (`RECHECK_EVERY_MS`, `mail_folders.rechecked_at`), and each re-read is an info entry in the activity log.
5. **Report a lasting gap.** At the end of each sync, `reportLastingDifferences` writes one error entry to the activity log (kind `completeness`) for each folder whose gap:
   - has lasted a day (`REPORT_AFTER_MS`),
   - has survived a re-read,
   - and has not been reported yet (`mail_folders.difference_alerted_at`).

   The alert rules email it under the new alert `completeness` ("A folder stays different from Microsoft"). The mark clears when the folder matches again.

6. **The console.** The mailbox page shows each folder's explanation beside Microsoft's count: items waiting, items that failed five tries, items that are not messages. For an unexplained gap it shows how long it has lasted and when the folder was last re-read. The dashboard counts only unexplained gaps.

No backup file is written, moved or deleted by any of this. A re-read stores missing messages through the normal sync path.

Migrations `0008` and `0009` add four nullable columns to `mail_folders`. 0.11.0 ignores them, so a rollback to it is safe.

## 2a. Three plain states (0.12.2)

On a real tenant, three folders showed as differing, and the admin could not tell whether to do anything:

- an archive's hidden PersonMetadata folder (Outlook's contact metadata, not mail);
- two Deleted Items folders a few items short, which were meeting requests or contacts that a message listing never returns.

So the check now speaks in three states, and only one of them asks for anything:

- **Not compared.** Hidden folders (`isHidden` on a mail folder) and archive folders whose class is not `IPF.Note` (PersonMetadata, contacts, calendars), and any folder inside one, have no count. A count saved before is cleared at the next sync.
- **Explained.** Shown beside Microsoft's count on the mailbox page only: items waiting to be copied again, items that failed five tries, items that are not messages.
- **Checking.** A gap nothing explains yet. The folder is read again from the start (which also measures items that are not messages, so a Deleted Items surplus of meetings becomes Explained), and the gap stays Checking for a day after that. Nothing to do.
- **Needs a look.** Still there a day after a re-read. This is the only state that alerts (the same rule as before) and the only one the dashboard calls out.

A mailbox's completeness is the worst of its folders: complete, `checking` or `needs-look`. The Mailboxes page's State list has "Incomplete: checking" and "Incomplete: needs a look" (`?state=checking`, `?state=needs-look`). Its default is now "In the backup", which leaves out mailboxes not in scope and excluded ones; `?state=all` shows every mailbox. The dashboard's Completeness line links to those filters. The mailbox page lists each Checking or Needs a look folder on one line: what is missing, what Lookstow is doing about it, and when it last checked.

## 3. Acceptance criteria

| #   | Criterion                                                                                            | Test                                                                                          |
| :-- | :--------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| 1   | Microsoft's count is read after the folders sync                                                     | `mailbox-sync.test.ts` "reads Microsoft's counts after the folders sync, not before"          |
| 2   | Matches, unchecked folders, explained and unexplained gaps are told apart                            | `views.test.ts` "explaining a difference"                                                     |
| 3   | Items waiting to be copied again explain a gap; the mailbox does not differ                          | `views.test.ts` "items that failed to copy explain a gap"                                     |
| 4   | A full listing measures items that are not messages and keeps them                                   | `views.test.ts` "a full listing measures the items that are not messages"                     |
| 5   | A lasting gap makes the next sync read the folder from the start; missing messages are copied        | `mailbox-sync.test.ts` "reads a folder that keeps differing again from the start"             |
| 6   | Re-reads wait for the gap to last and happen at most once a day                                      | `views.test.ts` "reads a folder again only after the gap has lasted"                          |
| 7   | A gap that outlasts a re-read by a day is reported once, and the mark clears when the folder matches | `views.test.ts` "reports a difference that outlasts a re-read by a day"                       |
| 9   | A gap nothing explains is Checking, with both counts and when it began                               | `views.test.ts` "a gap nothing explains is Checking"                                          |
| 10  | It needs a look only when still there a day after a re-read                                          | `views.test.ts` "it needs a look only when still there a day after a re-read"                 |
| 11  | A hidden or non-mail folder is not compared; its old count and difference are cleared                | `views.test.ts` "a hidden or non-mail folder is not compared"; `completeness-folders.test.ts` |
| 8   | Only the lasting-gap entry emails                                                                    | `alerts.test.ts` "alertFor"                                                                   |
