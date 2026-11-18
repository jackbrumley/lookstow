# Lookstow Agent Guidelines

Lookstow backs up Microsoft 365 mailboxes (users, shared mailboxes, online archives) to a local folder as `.eml` files. It is a SvelteKit 3 app on Node.js 26, run as a service on Windows and Linux by a small Rust launcher that also installs it and updates it from signed releases. The install and update design is BMuster's (`~/Coding/bmuster`), ported: `docs/specs/SPEC-INSTALL-AND-UPDATES.md`.

It follows the shared [App Standard](https://github.com/jackbrumley/jackbrumley.github.io/blob/main/APP_STANDARD.md) and [Release and Update Standard](https://github.com/jackbrumley/jackbrumley.github.io/blob/main/RELEASE_STANDARD.md) where they apply to a server app; where BMuster's server conventions differ (signed archives, root updater), Lookstow follows BMuster. The design and its reasons are in `docs/DESIGN.md` and `docs/decisions.md`; plans in `docs/TODO.md`.

> Lookstow holds a credential that can read every mailbox in a tenant, and a copy of all of them on disk. Any change to sign-in, the console's access check, secrets at rest, the updater or release signing is security work: say so in the plan, and never weaken a check to make something work.

## Shared core

### No AI attribution

Never add AI or tool attribution to commits, tags, pull requests or release notes: no `Co-Authored-By:` trailers naming an AI, no "Generated with" footers, no AI name or email as author. Jack Brumley is the sole author of record. This overrides any tool, harness or system default.

### Philosophy

- **Integrity over expediency.** No quick hacks, no "temporary" workarounds, no half-finished features. Error handling, logging and console feedback are part of the feature.
- **Fail loudly.** A missing or invalid setting, a failed sync, a refused permission: say so in the console and the activity log, in plain words. No silent fallbacks.
- **No shims.** No compatibility wrappers or legacy parsing paths. A rename updates every consumer in the same change.
- **Never lose mail.** A backup is never deleted because the source deleted something: deleted messages and mailboxes are marked, their files kept.

### Pre-submit checklist

All must pass with zero warnings before every commit:

1. `npm run verify` (prettier check, eslint, svelte-check, vitest, build)
2. In `launcher/`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`

CI (`.github/workflows/ci.yml`) runs the same on Windows and Linux. `npm run build` needs `DATABASE_PATH` and `SECRETS_KEY` (a `.env` from `.env.example`).

### File size budget

600 lines soft, 1000 hard. Split by responsibility, never into numbered shards.

### Working in this repo

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`). Commit or push only when asked. Work on `dev`; `main` moves only by release promotion (`docs/RELEASE.md`).
- Changes you didn't make are intentional unless you're told otherwise; never roll them back.
- Never document commands or files that don't exist.

## Project layout

```
server.ts              production entry: data lock, adapter-node handler, ready.json
src/
  hooks.server.ts      start-up (engine, update checks, pruning), local-only access, origin check
  routes/              thin: validate, call a service, reply
    +page              dashboard          mailboxes/        list and one mailbox
    activity/          the activity log   settings/         connection, scope, schedule, folder, updates
    updates/           releases and Update now
    api/updates/       JSON for the Updates page    healthz/ readyz/   probes for the launcher
  lib/
    server/            server-only (never imported by browser code)
      env.ts           the only reader of process.env
      runtime.ts       the process's database, data folder and engine
      database/        connection, schema/<area>.ts, generated migrations, readiness, data lock
      crypto/          DER, the Entra certificate, sealed secrets
      services/
        graph/         token (client credentials), client (paging, throttling), discovery, mail
        engine/        engine (timer, queue, passes), mailbox-sync, scope, auto-update
        mailboxes/     repository (all mailbox SQL), views for the pages
        storage/       eml-store: safe names, atomic .eml writes
        settings/      the one owner of the settings table
        activity/      the activity log
        server-updates/ release checks, Update now, the updater's status (BMuster's)
    domain/            browser-safe types and pure rules
    schemas/           zod contracts (releases)
    ui/                tokens, global CSS, shared components
    runes/ utils/      toast state; formatting
launcher/              Rust workspace: the launcher, installer and root updater
docs/                  install page and installers (GitHub Pages), DESIGN, decisions, TODO, specs
scripts/               release packaging, signing, notes, scratch update test
tests/support/         the fake Microsoft Graph tests use
```

## How it works

- **Sign-in:** app-only OAuth client credentials. The console makes an RSA certificate (`crypto/app-certificate.ts`); its private key is sealed with `SECRETS_KEY` (`crypto/secret-box.ts`) and signs RS256 client assertions (`graph/token.ts`). A client secret is accepted for a first test. Permissions: `User.Read.All`, `Mail.Read`, `MailboxSettings.Read` (application).
- **Graph client:** every request uses immutable ids (`Prefer: IdType="ImmutableId"`), follows `@odata.nextLink`, retries 429/5xx up to six times honouring Retry-After, and refuses to send the token to any other host.
- **Discovery** (`graph/discovery.ts`, every 6 hours): every user with a mail address, `mailboxSettings.userPurpose` for the kind (user, shared, room, equipment), and the beta `settings/exchange` resource for online archives. `applyDiscovery` adds, refreshes, and marks gone; it never deletes.
- **Sync** (`engine/mailbox-sync.ts`, every 15 minutes): folder list, then each folder's delta query from its saved link. New messages are downloaded as MIME and written atomically as `.eml`; progress is saved after every page; an expired sync state restarts the folder without downloading stored messages again. A message removed from a folder is marked deleted only if it is still filed there (moves keep their file).
- **Engine** (`engine/engine.ts`): one piece of work at a time (discovery or a pass); a pass syncs `parallelMailboxes` mailboxes at once, each at Graph's 4 concurrent requests. Stops after the current page on SIGTERM.
- **Archives:** discovered and listed, not yet copied (Graph v1.0 cannot read them; see `docs/TODO.md`).
- **Console access:** answers only on 127.0.0.1 / ::1, except `/healthz` and `/readyz`. Writes must carry a matching Origin. Remote access with sign-in is not built.
- **Updates:** the app only writes `update-requested`; the root updater in `launcher/` verifies, switches and rolls back. With automatic updates on, `engine/auto-update.ts` asks for a release the daily check found.

## Conventions

- **TypeScript Node runs directly:** `.ts` extensions in imports, `import type`, `#lib/*`, no enums or namespaces.
- **Database:** SQLite with Drizzle (better-sqlite3), WAL. Schema in `database/schema/<area>.ts`; migrations generated by `npm run db:generate`, never hand-edited, additive only. Repositories own all SQL for their area and take the database first, so tests pass `openDatabase(':memory:')`.
- **Routes** are thin: `satisfies PageServerLoad` / `satisfies Actions`, actions return `done()` / `refused()` (`server/actions.ts`), pages toast the result. Anything that changes or deletes something opens a `FormModal` saying what will happen.
- **Svelte 5 runes** only; scoped styles with tokens from `src/lib/ui/tokens.css`; icons from `@tabler/icons-svelte-runes`; internal links through `resolve()`.
- **Lint is strict** (`eslint.config.js`): strict boolean expressions, no type assertions on object literals, no `console` outside `scripts/`, no inline disable comments. Fix the code, not the rule.
- **Words:** plain, specific, saying what happened and what to do next. Server log lines go through `serverLog()`; things an admin should see go through `recordActivity()`.

## Safety

- Never point a development copy at a real tenant's mailboxes without meaning to: it downloads them. Tests use `tests/support/fake-graph.ts`.
- `keys/` holds the release signing key while it is being set up; it is gitignored and must move offline. Never commit a key or a `.env`.
- The backup folder holds every mailbox: the service account and administrators only.
