# SPEC-SCALE: a console that stays quick as the backup grows

Status: built in 0.13.0.

## Why

With five mailboxes (545,000 messages, a 1.6 GB index) the console took 6 to 26 seconds a page and the
update check timed out. Lookstow ran everything on one Node thread, and SQLite answers on the thread
that asks. An AI sweep was searching every 2.4 seconds, and each search counted the AI content index
row by row (1.4 s) and matched words with `LIKE '%…%'` over every message. While a query ran, nothing
else could: not a page, not the health check, not the update check. More mailboxes would make every
one of those reads longer.

## What changed

### 1. Two threads

The service is still one process, one launcher and one updater. Inside it:

- **The web thread** answers the console: pages, `/healthz`, update checks, Update now. It has its
  own database connection and reads only small, indexed things.
- **The work thread** (`src/lib/server/work/`) runs everything that reads or writes a lot: the backup
  engine, email alerts, the throughput monitor, the search index keeper, the AI content reader and
  the AI tools (`/mcp`). AI tool calls run one at a time, with a turn for the engine before each.

They talk through messages (`work/protocol.ts`). The work thread sends a snapshot every second: the
live status, the learned pace, the lockdown reason, its slow queries and how long it was held. Pages
read the latest snapshot and never wait for the engine. Commands the engine answers at once (Sync now,
Cancel) are sent without waiting; the rest (Pause, Resume, Move, AI tools) wait for the answer.
Activity recorded on the web thread is passed on, so email alerts still hear about it. Log lines from
the work thread go to the web thread, which writes them and keeps them for the Log page. Email is
sent only by the work thread's alerts (Send a test asks it), so a due email is never sent twice.
Both connections wait up to 30 seconds for the other's write (a long delete) instead of failing.

If the work thread stops unexpectedly, it is started again after 5 seconds, and meanwhile the live
status says so. Start-up waits until the work thread says it has started, so a release whose work
thread cannot start never reports ready, and the updater rolls it back. A work thread that starts
but cannot take its snapshot (a broken setting) still lets the console start and show the error.

- **The AI tools' thread** (0.13.2, `work/ai-main.ts`) answers `/mcp` and its attachment downloads,
  one call at a time, on its own connection. It starts with the first AI call. Before, the tools ran
  on the work thread, and an agent searching all day held the backup engine for seconds a call.

A second thread, not a second service: one service to install, update and roll back, both halves
always the same version, and they stop together.

A release bundles the work thread as `app/work.js` and the AI tools' as `app/ai.js` beside
`app/server.js`. `server.ts` tells the app where they are (`LOOKSTOW_WORK_ENTRY`, `LOOKSTOW_AI_ENTRY`). A source run uses the TypeScript file, with the version passed in.

### 2. The content file

`lookstow-content.db`, beside `lookstow.db`, attached to every connection as `content`, holds what
Lookstow can rebuild from the backup itself:

- `content_docs`: a doc number for each indexed message, the row number in the other tables.
- `content_headers`: an FTS5 trigram index over subject, sender and recipients (no positions).
- `content_text` and `content_body`: each message's text and attachment summary for the AI tools,
  and an FTS5 word index over the text (no positions). Version 0 marks a message not read yet.
- `content_meta`: the header index's cursor.

The main file keeps only the backup's records, so it, its daily snapshot and the updater's copy
before an update stay small. The content file is never backed up. If it is lost, or comes from a
different layout (`CONTENT_LAYOUT`), it is emptied and built again.

The 0.12 content index (`message_content`, 900 MB in the main file) is moved into the content file
by the work thread, a batch at a time, without reading any message again. It starts 10 minutes
after the service does: the updater decides whether to roll an update back within two minutes, so a
rolled-back 0.12 always finds its table as it left it. Until it has moved, the AI tools' content
filters match nothing and the content reader waits. Each batch is deleted from
the main file as it moves, and the empty table is dropped. The space it leaves in the main file is
reused by new mail; the file does not shrink by itself.

### 3. Search through the index

New messages are added to the header index a batch at a time, in the order they were stored, up to
a cursor. Search also reads every message above the cursor, so a message is found the moment it is
stored. SQLite gives a new message the highest row number plus one, so after a backup is deleted
(or the index is compacted or restored) new messages can take numbers below the cursor: the cursor
then goes back to 0 and the keeper walks every message again, keeping the docs it already has. While
more than 5,000 messages wait for the index (that walk, or the first build after the update),
search does not use it. Entries of messages no longer stored are removed once a day; the time of the
last pass is kept, so restarts do not put it off.

For each typed text of three characters or more, search first asks the index how many messages hold
all its three-character pieces, stopping past 5,000 (a few ms):

- **5,000 or fewer:** search fetches those messages by row number, checks each for the exact text
  (so results match the old `LIKE` exactly) and sorts them newest first.
- **More:** the text is common (an address's domain, "re:"), so search walks the messages newest
  first with the exact check, and the first page fills at once. The console then counts up to 5,000
  and says "More than 5,000 messages".

Shorter texts are checked the old way.

Body words for the AI tools are looked up in the word index; a word also finds words it starts
("timesheet" finds "timesheets"), and "time-sheet" asks for both parts anywhere. A full Message-ID
is looked up exactly.

### 4. Smaller fixes found by measuring

- Index progress is counted at most every 30 seconds, by its version index, not on every search.
- Each AI search reports how many messages the content reader has not read yet (from that count)
  instead of counting the search's matches without content.
- New indexes: `messages (mailbox_id, received_at)` and `messages (received_at)`, so newest first
  needs no sort (migration 0011).
- Stored totals add up each mailbox's count instead of counting every message. The newest stored
  file is found by row order instead of sorting every message.
- Each connection has a 64 MB page cache, 256 MB of memory-mapped reads and temporary tables in
  memory.
- The Mailboxes page is filtered, sorted and paged on the server, through a GET form (every choice is
  in the address). It sends one page of 100 rows, not every mailbox (540 KB for 1,817 mailboxes).

### 5. Long work says how far it has got (0.13.1)

The first build of the search index after an update, a walk after a deleted backup, and the move of
the old content table show a banner on every page ("Building the search index after the update:
230,000 of 545,592 messages (42%)") and write a Log line every tenth of the way. The 10-minute wait
before the move is said once. The installer says what it is doing, counts while it resets the data
folder's permissions (now only when they are not already Lookstow's), and waits for the console.

### 6. Seeing the next slowdown

- Every query that holds its thread for 100 ms or more is noted, with its SQL and no values. It is
  logged once per statement every 10 minutes (`slow-query`) and listed at `/api/throughput` under
  `threads.web.slowQueries` and `threads.work.slowQueries`.
- Each thread measures how long it was held in the last minute (`threads.*.held`). A minute with a
  hold of a second or more is logged (`slow-thread`).
- A request that takes 2 seconds or more is logged with its path (`slow-request`).

## Measured

On a copy of the live index (545,592 messages), paused and with no credentials, run from a release
bundle (`app/server.js` and `app/work.js`). The 0.12.4 column is the live server while the AI sweep
was searching.

|                                         | 0.12.4         | 0.13.0             |
| --------------------------------------- | -------------- | ------------------ |
| `/healthz`                              | 6.6 s          | 2 to 20 ms         |
| Dashboard                               | 26 s           | 20 to 140 ms       |
| Mailboxes                               | 11.7 s, 540 KB | 20 to 75 ms, 20 KB |
| Search "timesheet"                      | (not measured) | 80 to 200 ms       |
| Search for a rare word                  | 1.4 s          | 21 to 30 ms        |
| Search "re:" (144,000 matches)          | 1.7 s          | 40 to 55 ms        |
| AI search, one sender in one mailbox    | 2.4 s          | 180 to 300 ms      |
| AI search, body "timesheet" with photos | (not measured) | 130 to 190 ms      |

First start after the update: the migration takes about 2.5 s; the header index is built in about 7
minutes, a batch at a time; the content move takes about 2 minutes (5,300 messages a second, at
most half a second's hold per batch). Pages answer as above throughout; the web thread was never
held more than 40 ms. The content file ends up at 1.16 GB for 545,592 messages.

Also found by measuring and fixed: the archive linking pass after each start paged through an
archive in an order no index gave (100 to 240 ms a batch); it now pages by the (mailbox, Graph id)
index (1 ms a batch) in batches of 25, so a call to the work thread waits at most a few tens of ms.

## Not done

- The main file does not shrink after the content index moves out. A one-off compaction would need
  the service stopped for a minute or two; it can be an installer or console option later.
- Engine start-up still runs a few one-off queries of about a second each on the work thread.
- `governor.ts` is over the 600-line plan-a-split mark (unchanged here).
