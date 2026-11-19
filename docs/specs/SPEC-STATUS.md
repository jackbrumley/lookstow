# Spec: one live status for the console

## 1. Problem

The console showed live state from several places, each read at its own moment:

- The side bar read the engine in the layout's load. That load ran only on navigation, so on any page but the dashboard it stayed as it was when the page opened.
- The dashboard read the engine again in its own load and refreshed itself on its own timer.
- The Mailboxes pages asked the engine, mailbox by mailbox, whether each one was syncing.
- The Speed card's pace had no idle state, so it said "At the learned limit, probing" with nothing running.

Two parts of a page could disagree, and a page left open showed state that was no longer true.

## 2. Design

- **One snapshot.** `liveStatus()` (`services/engine/live-status.ts`) reads `engine.status()` once and builds the Speed card's view from that same status. The result (`LiveStatus` in `src/lib/domain/live-status.ts`) carries the moment it was taken (`at`).
- **One owner.** The root layout's load returns it as `live`, and it is the only load that asks the engine what is running. Page loads that show live state (the dashboard, Mailboxes, one mailbox) take it with `await parent()` and work out "syncing" from `live.engine.syncing`, never from the engine.
- **One refresh.** Every load that shows live state calls `depends(LIVE_STATUS)`. The layout invalidates `LIVE_STATUS` every 4 seconds while a sync or discovery runs and every 30 seconds otherwise (`refreshAfterMs`), on every page. One invalidation reruns the layout and the page together, so they refresh as one. Pages have no timers of their own.
- **Idle is a state.** The governor's pace phase includes `idle`: nothing in flight, nothing waiting, nothing started for 10 seconds. The Speed card shows Idle and hides the pace detail while idle.
- **Contradictions are named.** `statusContradictions()` lists every combination a snapshot must never show. `liveStatus()` logs each one it finds once, as a warning in the server log, so drift shows up instead of hiding.
- `/api/throughput` stays as it is, for scripts.

Polling, not a push stream: every page already worked this way, it survives restarts and updates, and a few seconds' delay does not matter here.

## 3. Acceptance criteria

| #   | Criterion                                                                                                                      | Test                                                                 |
| :-- | :----------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| 1   | Idle, syncing, paused, discovering and moving into the date layout each give a consistent snapshot and the right side-bar text | `live-status.test.ts` "is consistent and says what runs"             |
| 2   | Pages follow the work closely only while something runs                                                                        | `live-status.test.ts` "is busy only while a sync or discovery runs"  |
| 3   | Every forbidden combination is named                                                                                           | `live-status.test.ts` "names every combination that must never show" |
| 4   | The pace is idle after work stops, and never idle while requests are in flight                                                 | `governor.test.ts` (idle tests)                                      |
| 5   | No page reads the engine's running state outside the layout                                                                    | Review: `grep isSyncing src/routes` finds nothing                    |
