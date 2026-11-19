# Spec: throughput governor (download as fast as Microsoft allows)

Status: **plan, for approval**. Nothing here is built yet. Owner of the decision: Jack.

## 1. Goal

Copy mail as fast as Microsoft 365 lets one app copy it: as many mailboxes at once, and as many requests in each mailbox at once, as Microsoft accepts, found by measuring, held just under the limit, and kept between restarts. A single large mailbox or archive goes as fast as one mailbox can; a tenant goes as fast as the app, the network and the disk allow.

Not a goal: going past Microsoft's documented limits on purpose, or slowing people's Outlook (application limits are separate from users' own).

## 2. Where the time goes today (0.6.2)

| Part                       | Today                                                                                                                                      | Effect                                                                                 |
| :------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| Mailboxes at once          | `AdaptiveSlots`: starts at 3, +1 every 2 min while busy and unthrottled, halves at 5 throttles a minute, up to the setting (8, at most 32) | Slow to reach full speed; reacts to a burst, not to rate                               |
| Inside a mailbox (mail)    | 4 downloads at once, one folder at a time, each page of 100 changes waits for all its downloads before the next page is asked for          | Idle gaps at every page and folder edge                                                |
| Inside a mailbox (archive) | One `exportItems` request (20 items) at a time                                                                                             | Uses a quarter of what one mailbox may do: 2.8 MB/s, 8 items/s seen on Jason's archive |
| Throttling                 | Each request waits out its own `Retry-After`; nothing slows the next requests                                                              | The same limit is hit again and again                                                  |
| Memory                     | A whole message (up to 150 MB) is held in memory, then written                                                                             | More parallel work means more memory, unbounded                                        |
| HTTP                       | Node's default connection pool                                                                                                             | Not tuned for many long downloads to one host                                          |
| What it learned            | Nothing survives a restart                                                                                                                 | Every start climbs from the bottom again                                               |

## 3. Microsoft's limits (what the governor works within)

- **Per mailbox, per app:** 4 requests at once (more gets 429 `MailboxConcurrency`), and 10,000 requests per 10 minutes (about 16 a second).
- **Per app, all tenants:** a global limit far above what one tenant reaches.
- **Tenant and service load:** Exchange can throttle an app harder when the tenant or the server is busy. This is not published and changes with load: it has to be measured.
- **Mailbox export API (beta):** no published limits. Measured like the rest.
- **Signals:** 429 or 503 with `Retry-After`; the error code says which limit (mailbox concurrency, app or tenant). Some Microsoft services also send `RateLimit-*` headers before refusing; the governor uses them if Graph mail sends them.

## 4. Design

One component, the **governor** (`services/graph/governor.ts`), between every Graph request and the network. The Graph client asks it for permission before each request and reports how each one ended. Everything that syncs (mail, archives, discovery) gets its speed from it; nothing else counts requests or sleeps for throttling.

### 4.1 Three levels

1. **Per-mailbox lane.** At most N requests in flight for one mailbox (start 4, the documented limit; floor 1; ceiling 6, probed only if Microsoft allows it) and a request rate under the 10-minute budget (token bucket at 15 a second). A `MailboxConcurrency` 429 lowers only that lane. The lane is found from the request URL (`/users/{id}/…`, `/admin/exchange/mailboxes/{id}/…`), so callers do nothing.
2. **App-wide pace.** A token bucket for request starts per second across all mailboxes, and a cap on requests in flight in total, both adaptive, after SomeDrive's `AdaptiveDownloadLimit`:
   - before the first refusal: +5% starts a second and +1 in flight every 30 s while requests succeed;
   - on a 429 or 503 that is not a mailbox's own: both drop to 85% of the refused rate, held for 30 minutes, then probe +2% a minute;
   - one throttle burst is one cut: refusals of requests started before the cut ended (`Retry-After` + 10 s), or with fewer than 20 successes since, change nothing;
   - an early-warning header eases the rate 20%, at most every 30 s, before any refusal.
3. **Mailboxes at once.** Replaces `AdaptiveSlots`. A new mailbox starts while the governor has headroom (app pace not at its cap, no cut in the last minute, in-flight below its cap) and there is work waiting; one stops being added when lanes sit idle because the app pace is the limit. The Settings maximum stays as a cap (default raised from 8 to 32), and first copies still never take every slot.

### 4.2 Waiting, retries and fairness

- A throttled request gives back its permit while it waits, so its wait never holds a slot another mailbox could use. The retry asks the governor again.
- Lanes are served round-robin, so one huge mailbox cannot starve the others; first copies and up-to-date syncs share by the existing scheduler's rules.
- `Retry-After` is honoured exactly; the governor adds no fixed sleeps.

### 4.3 Work inside a mailbox: a pipeline, not pages

- **Mail:** the next delta page is fetched while the current one downloads; downloads from all folders feed one queue for the mailbox's lane, so the lane stays full across page and folder edges. Delta links are still saved only after every message on their page is stored (unchanged guarantee).
- **Archives:** `exportItems` batches run in parallel up to the lane's limit; items moved to an auxiliary archive go to that mailbox's own lane.
- **Large items:** messages over 8 MB use at most a quarter of a lane (SomeDrive's large-file lane), so a few big attachments do not stall thousands of small messages.

### 4.4 Memory, disk and network

- **Streaming:** a message is written to its temporary file as it downloads, with the SHA-256 computed on the way, then renamed (the same atomic write). Memory per download stays small whatever the message size. Archive exports, which come as base64 inside JSON, are bounded by a byte budget instead (at most 256 MB of export replies in memory at once).
- **Connection pool:** one keep-alive pool for `graph.microsoft.com`, sized to the governor's in-flight cap, with HTTP/1.1 keep-alive and no pipelining.
- **Disk:** writes are already sequential per file; the disk guard still pauses at its limit. Throughput is shown so a slow disk is visible.

### 4.5 Learning kept between restarts

The app pace (starts a second, in-flight cap, last refused rate and when) is saved every 5 minutes and at shutdown in the settings table (`throughput` key), and read at start-up, so a restart resumes just under the limit instead of climbing again. Settings > Speed has **Forget what was learned** to start again from the defaults.

### 4.6 What the console shows

Dashboard > Now gains a **Speed** block: MB/s and messages/s (exists), requests a second against the learned limit, requests in flight against the cap, mailboxes running and why no more (for example "Microsoft asked to slow down 4 minutes ago", "holding just under the limit until 10:42", "no more work waiting"), and the last cut with Microsoft's reason. The Log records every change of pace with its reason, as SomeDrive does.

### 4.7 Watching it live: `GET /api/throughput` and the pace history

So speed can be judged while it runs, on the real tenant, and not guessed:

- **`GET /api/throughput`** (JSON, read-only, local-only like the rest of the console, no write and no side effect). It holds:
  - rates over the last 10 s, 1 min and 15 min: requests a second, messages a second, bytes a second, 429s and 503s;
  - the app pace: starts a second allowed, in flight against the cap, phase (climbing, holding until a time, probing), last cut (when, refused rate, Microsoft's error code and `Retry-After`);
  - each lane (one per mailbox syncing): its limit, in flight, queued, requests and bytes a second, last throttle; mailboxes are named only by a short stable number (`mailbox-3`), never by address, name or id;
  - mailboxes running against the cap, and why no more start (the same reason as the dashboard);
  - the HTTP pool (sockets open and busy), memory in use by downloads against the byte budget, and disk write MB/s;
  - the last 50 pace changes with their reasons.
- **Pace history:** the same numbers sampled every 10 s, appended as JSON lines to `<data>/throughput-history.jsonl`, kept for 7 days (one file a day, older ones deleted), so a night's run can be read afterwards and compared phase to phase. The same rule applies: no addresses, subjects, ids or tokens.
- A test checks that nothing in either output matches an email address, a GUID or a Graph id.

### 4.8 Settings

Settings > Speed:

- **Mailboxes at once (most):** 1 to 32, default 32 (the governor decides below it).
- **Bandwidth cap (optional):** off by default; a MB/s cap for business hours, enforced as a byte-rate bucket on downloads.
- **Forget what was learned.**

### 4.9 Lessons taken from SomeDrive's sync engine

Beyond its adaptive limit (the model for 4.1), SomeDrive solved problems Lookstow has today:

1. **Timeouts and stalled downloads** (`http_clients.rs`): a connect limit, a total limit for small requests, and a 60 s "no data" limit for downloads. Lookstow's `fetch` has none: a half-open connection can hold a lane slot, and so a mailbox, for good. Lookstow adds an abort signal per request (30 s until the headers arrive) and an idle watchdog on the body (60 s without a byte), both counted as network errors and retried. No new dependency.
2. **One shared throttle window per scope, released with a probe** (`graph_context.rs`): when Microsoft throttles, every request in that scope (the mailbox's lane, or the app) waits until the window ends; then one request goes alone, and the rest follow spread over a few seconds. Each request sleeping out its own `Retry-After` and all waking together restarts the penalty.
3. **One token renewal at a time, and one retry after a 401** (`refresh_token_if_needed`): concurrent requests share the renewal in progress instead of each asking Entra; a 401 (a token withdrawn early) renews once and asks again.
4. **One bad message never stops a folder** (`job_queue_download_store.rs`): a `$value` that answers 404 means the message was deleted after the delta (recorded as such); any other failure is recorded per message with its attempts and next try, the delta link still moves on, and the message is tried again on later syncs, shown in the console after five failed tries. Downloads on a page settle together (`allSettled`), so a failure never leaves others running unwatched. Needs a migration (agreed with lookstow-7e before generating).
5. **Deletions during a delta restart** (`delta_resync_store.rs`): when a delta link has expired and the folder starts again, messages not seen by the fresh pass are checked one by one afterwards (404 means deleted) instead of staying "present" for good. Archive sync also treats `syncStateNotFound` like a 410, as mail sync does.
6. **Back-off for a failing mailbox** (`worker_lifecycle.rs`): after a failed sync a mailbox waits 30 s, doubling to at most 15 minutes, instead of its normal interval; failures are sorted into a few kinds (throttled, network, permission, disk, Microsoft error) for the dashboard.
7. **Retry-After** in every form: seconds, an HTTP date, and `retryAfterSeconds` in the JSON body.
8. Not taken: SomeDrive's ranged, segmented downloads (for files over 64 MB); `$value` and `exportItems` replies cannot be fetched in ranges.

## 5. Phases

Each phase is one release, gated like every release (full checks, changelog, tests).

| Phase | Version | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Touches `engine.ts`                               |
| :---- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| 1     | 0.7.x   | `GET /api/throughput`, the pace history and the dashboard Speed block (4.6) first (so the baseline is measured and visible before anything changes), then timeouts and stall detection (4.9.1), one token renewal at a time and a retry after a 401 (4.9.3), Retry-After in every form (4.9.7), then the governor with shared throttle windows released by a probe (4.9.2), (lanes, app pace, cuts, learning in memory), the Graph client asking it for every request, throttled waits releasing permits, the connection pool, and parallel archive export batches. Mail keeps today's structure. | No                                                |
| 2     | next    | Mailbox pipeline: page prefetch, one queue per mailbox across folders, large-item share, streaming writes with hashing, export byte budget; one bad message never stops a folder (4.9.4, with its migration); deletions checked after a delta restart (4.9.5).                                                                                                                                                                                                                                                                                       | No                                                |
| 3     | next    | Mailboxes at once driven by the governor's headroom (replaces `AdaptiveSlots`), default maximum 32, learning saved between restarts, Settings > Speed, the dashboard Speed block; back-off and kinds of failure for a failing mailbox (4.9.6).                                                                                                                                                                                                                                                                                                       | Yes: after lookstow-7e's split, in `sync-pass.ts` |
| 4     | next    | Tuning on the real tenant from the Log's pace changes; bandwidth cap if wanted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No                                                |

Numbering is agreed with lookstow-7e (its 0.7.0 and 0.8.0 are the index snapshot and completeness check); this work takes the next free versions.

## 6. How it is tested

- **A simulated Microsoft** in `tests/support/`: the fake Graph gains Microsoft's limits (4 per mailbox, a 10-minute budget, an app-wide rate that answers 429 with `Retry-After` past a threshold, early-warning headers) and a fake clock, so the governor's behaviour is tested without the network or real time.
- **Acceptance criteria** (each a named test):
  1. One mailbox never has more than its lane allows in flight, and a `MailboxConcurrency` 429 lowers only that lane.
  2. Against a simulated app limit, the pace climbs, is cut once per burst to 85% of the refused rate, holds 30 minutes, then probes; it settles within 10% under the limit and never cascades.
  3. A throttled request's wait frees its permit for other mailboxes.
  4. With 20 simulated mailboxes, total throughput is at least 90% of the simulated limit after the climb, and no mailbox is starved.
  5. An archive with 200 items exports with the lane full (4 batches in flight).
  6. Mail: the lane stays full across page and folder edges; delta links are saved only after their page's messages are stored, including when stopped midway.
  7. A 150 MB message is written with less than 16 MB of memory for it, and its SHA-256 matches.
  8. Learning saved and restored across a restart; Forget resets it.
  9. `/api/throughput` and the pace history hold no email address, GUID or Graph id, and answer only on this computer.
  10. Every existing sync, archive and stop-and-resume test still passes unchanged.
- **A benchmark script** (`scripts/throughput-bench.ts`) runs the engine against the simulated Microsoft and prints messages/s and MB/s, so each phase shows its gain.

## 7. Expected gains

Estimates, to be checked by the benchmark and then on the tenant:

- **One archive (Jason's):** about 3–4× (parallel export batches), roughly 2.8 MB/s to 8–10 MB/s.
- **One normal mailbox:** about 10–30% (no idle gaps), more for many small folders. One mailbox stays bound by Microsoft's 4 requests at once.
- **Many mailboxes:** close to linear in the number of mailboxes until the tenant's limit, the internet link or the disk is reached, and held there instead of oscillating.

## 8. Risks

- **Unpublished limits** (tenant load, the beta export API) can only be learned; the first days on a tenant will show cuts in the Log while it finds them. Learning between restarts keeps that to once.
- **Beta export API** can change; the governor treats it like any other request.
- **Other apps in the tenant** share Exchange's load. The governor backs off when Microsoft says so, which is the polite behaviour, but it cannot see other apps.
- **Coordination:** phase 3 changes the engine and waits for lookstow-7e's split.

## 9. Open questions for Jack

1. Approve the design and the phasing (phase 1 first, released on its own)?
2. Default maximum mailboxes at once: 32 (the governor decides below it), or keep 8 until the tenant has been measured?
3. Bandwidth cap: build it in phase 3, or leave it out until needed?
4. Pace history kept 7 days in the data folder: enough, or longer?
