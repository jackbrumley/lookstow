# Spec: evidence packs

## 1. Problem

A legal or compliance matter needs a set of backed-up messages handed over, for example to a lawyer on a memory stick, in a form they can open and that shows nothing was changed. A set can be thousands of messages and several gigabytes. The messages are chosen elsewhere: by a person, or by an AI agent working through the AI tools.

## 2. Design

- **Asking for a pack.** The Evidence packs page takes pasted text and picks every Lookstow message id out of it (a list, a column from a spreadsheet, links to `/messages/<id>`), leaving out repeats. Check shows how many were found, which ids are not in the backup, the size, and the free space; Make the pack starts it. AI agents use the MCP tools `create_evidence_pack` (ids as a list), `list_evidence_packs` and `get_evidence_pack`. At most 50,000 messages a pack. A pack that would not fit on the data folder's drive (with room to spare) is refused.
- **Where it is made.** On the reading thread (`work/ai-main.ts`, which also serves the AI tools and the viewer), one pack at a time in the order asked (`services/evidence/builder.ts`). Files are read and compressed asynchronously, so the thread still answers meanwhile. Each pack lives in `<data>/evidence-packs/<id>/`: `pack.json` (its state), `request.json` (the ids, in order), the ZIP. The data folder is for the service and administrators only, which a copy of mail needs. Every thread reads a pack's state from these files; the builder writes it every 5 seconds while it holds the pack, so a pack left by a stopped service (no longer moving for a minute) shows as failed, with Make again.
- **The ZIP** (`services/evidence/zip-writer.ts`) is written front to back, never held in memory: deflated, or stored when that is no smaller; UTF-8 names; ZIP64 only past 4 GB or 65,535 files. Own code on Node's zlib rather than a dependency. Its SHA-256 is worked out as it is written.
- **What is in it** (`services/evidence/pack-contents.ts`), in a folder named after the pack:
  - `messages/<mailbox>/<date time UTC> <subject> [<id start>].eml`: each message exactly as stored. An online archive item (stored as Microsoft's export) is written out as .eml.
  - `attachments/…` (optional): each attachment as its own file, in a folder named like its message.
  - `manifest.csv`: one line a message (file, id, mailbox, folder, dates, from, to and cc, subject, Message-ID, deleted at source, the SHA-256 recorded when stored, the file's SHA-256, and the check). UTF-8 with a byte-order mark for Excel; a cell starting with `= + - @` is prefixed so it never runs as a formula.
  - `index.html`: the same list as a page, linking to each file; no scripts, nothing loaded.
  - `README.txt`: what it is, who asked and when, how the files were checked, how to check them, and the ids not in the backup.
  - `SHA256SUMS.txt`: every file's SHA-256, in the form `sha256sum -c` reads.
- **Checks.** Each stored file is checked against the SHA-256 recorded when it was backed up: `matches`, `converted` (an archive item), `MISMATCH` (included as found, and counted on the page) or `MISSING` (could not be read; left out and listed).
- **Downloading.** `/evidence-packs/<id>/download` (the console) and `/mcp/evidence-packs/<id>/download` (the AI access token) stream the file from disk with its size, and resume a dropped download (byte ranges, with the SHA-256 as ETag and If-Range).
- **Who.** The console on this computer; remote accounts only when given "Evidence packs: allowed" in Settings (off by default), and they can stop or remove only their own; AI agents with the access token. Asking, finishing, failing, downloading (from the start) and removing each go to the activity log, with who.
- **Keeping.** A pack is removed 7 days after it finished or failed, or sooner by hand. Stopping one being made removes it.

## 3. Not done

- Splitting a pack into several ZIPs for FAT32 memory sticks (4 GB a file): not wanted; format the stick exFAT.
- Encrypting the ZIP: Windows cannot open AES ZIPs by itself; use BitLocker To Go on the stick.
- Choosing messages by a search on the page: ids come from the AI tools or the compliance report.

## 4. Acceptance criteria

| #   | Criterion                                                                                                    | Test                                                         |
| :-- | :----------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| 1   | Ids are found in pasted links, columns and text, once each                                                   | `domain/evidence-packs.test.ts` "are found in links"         |
| 2   | A pack left by a stopped service shows as failed; packs expire                                               | `domain/evidence-packs.test.ts` "left building…", "expires…" |
| 3   | The ZIP reads back exactly, compressed or stored; ZIP64 past its limits                                      | `evidence/zip-writer.test.ts`                                |
| 4   | A dropped download resumes from a byte range                                                                 | `evidence/zip-writer.test.ts` "reads one byte range"         |
| 5   | Messages go in as stored, are checked, and missing, changed and unreadable ones are reported; sums are right | `evidence/builder.test.ts` "puts each message in as stored"  |
| 6   | Nothing that is not in the backup makes a pack                                                               | `evidence/builder.test.ts` "refuses when none…"              |
| 7   | A pack asked to stop is removed                                                                              | `evidence/builder.test.ts` "stops and removes…"              |
| 8   | AI agents make a pack, follow it, and get its download URL                                                   | `ai/mcp.test.ts` "makes an evidence pack"                    |
| 9   | Remote accounts reach packs only with the right                                                              | `domain/remote.test.ts` "opens evidence packs only…"         |
| 10  | Windows opens the ZIP; a real pack downloads and resumes over HTTPS                                          | Smoke test of a built server                                 |
