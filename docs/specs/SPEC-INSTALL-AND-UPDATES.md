# SPEC-INSTALL-AND-UPDATES: One-command install and whole-install updates

**Status:** `IMPLEMENTED (launcher only)` 2026-11-18 · the maintainer chose to copy BMuster's install and update architecture exactly (BMuster SPEC-SERVER-INSTALL and SPEC-SERVER-UPDATES, "As built"). This spec is the Lookstow version. The launcher (`launcher/`) is built and tested; the app side, the packaging script, the installers and the release workflow are separate pieces of work that must match sections 6 to 9.

## 1. Problem

Lookstow backs up Microsoft 365 mailboxes to local disk. It runs as a service on Windows or Linux, with a local web console. It must install with one command and then update itself, launcher and Node runtime included, without anyone re-running the installer.

- Linux: `curl -fsSL https://<site>/install.sh | sudo sh`
- Windows (PowerShell as Administrator): `irm https://<site>/install.ps1 | iex`

## 2. Decisions

- **One release bundle per platform**, `x86_64-unknown-linux-gnu` and `x86_64-pc-windows-msvc`. Each holds the built app, a pinned Node runtime and the launcher, so nothing else needs installing. No arm64.
- **Why not one compiled file:** the app uses native Node modules (SQLite), which Node single-executable apps and `bun --compile` break.
- **Pinned Node:** the version in `.node-version` (26.13.0). The packaging script downloads the official build and checks it against nodejs.org's `SHASUMS256.txt`.
- **Launcher:** `lookstow` (`lookstow.exe`), a Rust binary in `launcher/crates/lookstow`. It runs the bundled Node on the app, installs the service, and is the root updater. The systemd and Windows service plumbing lives in the library crate `lookstow-service` (`launcher/crates/service`).
- **glibc floor:** Linux release builds of the launcher are linked against glibc 2.31 with `cargo zigbuild` (Debian 11+, Ubuntu 20.04+), as in BMuster. Node 26 needs glibc 2.28.
- **Console default:** plain HTTP on `127.0.0.1:8030`. There is no local network mode, no TLS and no firewall rule. An admin who wants the console elsewhere changes `HOST` and `PORT` in `server.env` and opens the port.
- **The web app says when; a root updater decides what.** An update is the installer running itself, for the whole install (section 8).

## 3. Paths

|               | Linux                                                                                         | Windows                                                                             |
| :------------ | :-------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| Program       | `/opt/lookstow` (root, 0755)                                                                  | `C:\Program Files\Lookstow`                                                         |
| Releases      | `/opt/lookstow/releases/<version>/`                                                           | `C:\Program Files\Lookstow\releases\<version>\`                                     |
| Running       | `/opt/lookstow/current` → `releases/<version>` (relative)                                     | `C:\Program Files\Lookstow\current` (directory symlink, relative)                   |
| Switch record | `/opt/lookstow/update-switch.json`                                                            | `C:\Program Files\Lookstow\update-switch.json`                                      |
| Updater lock  | `/opt/lookstow/update.lock`                                                                   | `C:\Program Files\Lookstow\update.lock`                                             |
| Data          | `/var/lib/lookstow` (user `lookstow`, 0700)                                                   | `C:\ProgramData\Lookstow` (SYSTEM, Administrators, LocalService modify)             |
| Settings      | `<data>/server.env` (0600)                                                                    | `<data>\server.env`                                                                 |
| Database      | `<data>/lookstow.db`                                                                          | `<data>\lookstow.db`                                                                |
| Backups       | `<data>/backups/pre-update-<from>-to-<to>.db`                                                 | same                                                                                |
| Service       | `lookstow.service`, system user `lookstow`                                                    | `Lookstow` ("Lookstow (Microsoft 365 mailbox backup)"), `NT AUTHORITY\LocalService` |
| Updater       | `lookstow-update.path` → `lookstow-update.service` (root); `lookstow-recover.service` at boot | scheduled task "Lookstow Update", SYSTEM, every minute; LocalService may start it   |
| Log           | journald: `journalctl -u lookstow`                                                            | `<data>\server.log` (moved to `server.log.old` above 10 MB)                         |

`--prefix <dir>` and `--data-dir <dir>` replace the program and data folders on every command.

## 4. Bundle layout

The signed archive `lookstow-app-<target>.tar.gz` has **no top folder**. Its top level may hold only these five names:

```
lookstow[.exe]      the launcher (this release's own)
VERSION             the app version (package.json "version"), one line
LICENSE
node/               Node 26: bin/node (Linux) or node.exe (Windows), its licence
app/                a plain Node app
  server.js         server.ts bundled, every library inlined except better-sqlite3
  build/            adapter-node output
  node_modules/     better-sqlite3 only, for this platform (no symlinks: drop node_modules/.bin)
  package.json      "version" must equal VERSION and the manifest
  src/lib/server/database/migrations/   applied at start-up, relative to app/
```

Archive rules (the updater refuses anything else): only regular files and folders (no symlinks, hard links or devices), no `..` or absolute paths, no duplicate paths, no setuid, setgid or sticky bits, at most 100,000 entries, 2 GiB unpacked and 1 GiB compressed. After unpacking, `lookstow[.exe]`, `node/bin/node` or `node/node.exe`, `app/server.js`, `app/package.json` and `VERSION` must exist.

`lookstow-windows-x64.zip` (for `install.ps1`) holds the same tree inside one top folder, `lookstow/`. The installer unpacks it and runs `lookstow\lookstow.exe install`; `install` copies the bundle it was run from, so it must be run from inside an unpacked bundle.

## 5. Launcher commands

| Command                                                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| :--------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookstow run [--data-dir <dir>]`                                                  | Foreground, and the Linux service. Needs `server.env`. Runs Node (section 6), restarts it after a crash (2 s, doubling to 60 s, back to 2 s after 10 minutes up), stops it on SIGTERM or SIGINT (SIGTERM, then a kill after 15 s). One launcher per data folder (`<data>/launcher.lock`). On Unix it first tightens the data folder to 0700 and `server.env` to 0600.                                                                                                                                       |
| `lookstow run --service --data-dir <dir>`                                          | Windows only, hidden: the service entry point. Node's output goes to `server.log`. A Stop kills Node (Windows has no SIGTERM for a console-less child; SQLite's WAL keeps the database whole).                                                                                                                                                                                                                                                                                                              |
| `lookstow install [--prefix <dir>] [--data-dir <dir>] [--port <n>] [--no-service]` | Root or Administrator unless `--no-service`. Stops the running service, copies the bundle it runs from to `releases/<version>` (staged, then renamed), points `current` at it, keeps the release before and prunes the rest, deletes any switch record, creates the data folder and `server.env` if missing, locks the data folder down (I16), creates the system user (Linux), writes the units or the service and scheduled task, and starts the service. `--port` applies only when `server.env` is new. |
| `lookstow install --refresh-units [--prefix] [--data-dir] [--no-service]`          | Internal: the updater runs it from the new release. Rewrites the service definitions and repeats the data lockdown.                                                                                                                                                                                                                                                                                                                                                                                         |
| `lookstow update [--prefix] [--data-dir]`                                          | Root or SYSTEM. Exits at once with no flag and no switch record; otherwise section 8. Exit 1 when the update failed.                                                                                                                                                                                                                                                                                                                                                                                        |
| `lookstow update --recover [--prefix] [--data-dir]`                                | At boot, before the service: finishes or undoes an interrupted update without touching the service.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lookstow uninstall [--prefix] [--data-dir] [--purge]`                             | Removes the service, updater units or task, and the program folder; keeps the data unless `--purge` (Linux `--purge` as root also removes the user). Refuses a program folder that is not an install, and with `--purge` a data folder with neither `server.env` nor `lookstow.db`. On Windows, when run from inside the program folder, a detached `cmd` removes the folder a few seconds after exit.                                                                                                      |
| `lookstow status [--prefix] [--data-dir]`                                          | Version, folders, service state, console address, last update message, log location.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lookstow --version`                                                               | `lookstow <version>` (the Cargo workspace version, kept equal to package.json).                                                                                                                                                                                                                                                                                                                                                                                                                             |

`server.env` of a fresh install:

```
SECRETS_KEY=<32 random bytes, base64>
HOST=127.0.0.1
PORT=8030
```

It is written once and kept on every upgrade. Admins may add other settings; the launcher reads only `HOST` and `PORT` (to print the address) and fails `status` politely when either is missing.

## 6. What the launcher gives the app

The launcher runs, with the working directory `<release>/app`:

```
<release>/node/bin/node --env-file=<data>/server.env <release>/app/server.js      (Linux)
<release>\node\node.exe --env-file=<data>\server.env <release>\app\server.js     (Windows)
```

| Variable                   | Value                                                  |
| :------------------------- | :----------------------------------------------------- |
| `NODE_ENV`                 | `production`                                           |
| `DATABASE_PATH`            | `<data>/lookstow.db`                                   |
| `LOOKSTOW_DEPLOYMENT`      | `installed`                                            |
| `LOOKSTOW_UPDATE_DATA`     | the data folder (absolute when the folders are)        |
| `LOOKSTOW_LAUNCHER_TARGET` | `x86_64-unknown-linux-gnu` or `x86_64-pc-windows-msvc` |
| `LOOKSTOW_READINESS_NONCE` | 64 lowercase hex characters                            |

`SECRETS_KEY`, `HOST`, `PORT` and the admin's own settings come from `server.env` through `--env-file`. stdin is closed.

The app must:

1. **Report ready.** Once it listens, write `<data>/ready.json` as `{"nonce":"<LOOKSTOW_READINESS_NONCE>","version":"<its package.json version>"}` (exactly these two keys; any other key makes the updater ignore the file), written to `ready.json.new` and renamed over `ready.json`. The updater counts a release healthy only when both values match.
2. **Request an update** by creating an empty `<data>/update-requested` (contents are ignored; create with `wx` so a second request is refused).
3. **Show progress** from `<data>/update-status.json` (below). It is written only by the updater and is world-readable (0644).
4. **Stop within 10 s of SIGTERM** (the launcher kills it after 15 s; the unit allows 25 s).
5. **Apply migrations at start-up** from `src/lib/server/database/migrations/` relative to its working directory. Migrations stay additive, so an older release can run on a newer database when the manifest says so.

`update-status.json`:

```json
{
	"phase": "healthy",
	"from": "0.1.0",
	"to": "0.2.0",
	"message": "Lookstow 0.2.0 is running; 0.1.0 is kept for recovery.",
	"atMs": 1763430000000
}
```

`phase` is one of `checking`, `up-to-date`, `downloading`, `switching`, `starting`, `healthy`, `rolled-back`, `failed` (`starting` is defined but not written today, as in BMuster). `from` and `to` are strings or `null`. Unknown keys are refused when the launcher reads it.

## 7. Release signing and the manifest

Public key: `launcher/crates/lookstow/release-key.pub`, the raw 32-byte Ed25519 key in base64 on one line (as SubjectPublicKeyInfo PEM: `MCowBQYDK2VwAyEANoI28cmlgW11Gup4qsdQpWPWUVZk9r78P8+FhvNKw4c=`). It is compiled into the launcher. The private key was generated with `openssl genpkey -algorithm ed25519` into `keys/lookstow-release-key.pem` (gitignored) and must move offline and into the release workflow's secret.

`lookstow-app-<target>.json` is one line, `{"payload":"<base64>","signature":"<base64>"}` (standard base64 with padding). The signature is Ed25519 over the bytes `LOOKSTOW-SERVER-UPDATE-1\n` followed by the decoded payload. The payload is a JSON object with exactly these keys (BMuster's names; unknown keys are refused):

| Key               | Rule                                                                               |
| :---------------- | :--------------------------------------------------------------------------------- |
| `schemaVersion`   | `1`                                                                                |
| `version`         | stable semver (no pre-release or build part), newer than the installed version     |
| `target`          | the launcher's target triple                                                       |
| `archive`         | `lookstow-app-<target>.tar.gz`                                                     |
| `bytes`           | the archive's size, 1 byte to 1 GiB                                                |
| `sha256`          | the archive's SHA-256, 64 lowercase hex characters                                 |
| `minimumLauncher` | the oldest installed version whose updater may install this release by itself      |
| `nodeMajor`       | `26` (informational)                                                               |
| `rollbackFrom`    | at most 32 stable versions that can run on the database this release leaves behind |

GitHub: the updater asks `https://api.github.com/repos/jackbrumley/lookstow/releases/latest` (drafts and pre-releases refused; the tag must be `v<version>`) and downloads `https://github.com/jackbrumley/lookstow/releases/download/v<version>/<asset>` over HTTPS only. The installers use `releases/latest/download/<asset>`. `SHA256SUMS` sits beside the assets.

Release build commands (from `launcher/`):

| Target  | Command                                                                       | Output                                                        |
| :------ | :---------------------------------------------------------------------------- | :------------------------------------------------------------ |
| Linux   | `cargo zigbuild --release --target x86_64-unknown-linux-gnu.2.31 -p lookstow` | `launcher/target/x86_64-unknown-linux-gnu/release/lookstow`   |
| Windows | `cargo build --release --target x86_64-pc-windows-msvc -p lookstow`           | `launcher/target/x86_64-pc-windows-msvc/release/lookstow.exe` |

Release builds never enable the `scratch-test` feature and never set `LOOKSTOW_EXTRA_RELEASE_KEY`.

## 8. Update flow

1. **Request.** An admin confirms Update now; the app writes the empty flag. That is all it can do.
2. **Trigger.** Linux: `lookstow-update.path` (`PathExists=<data>/update-requested`) starts `lookstow-update.service`, a root one-shot running `<prefix>/current/lookstow update --prefix <prefix> --data-dir <data>`. Windows: the SYSTEM task runs the same command every minute, and at once when the app starts it (`schtasks /Run`): the task, registered from XML, grants LocalService read and run (`D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;LS)`), runs on battery, and never runs twice at a time. The updater writes `<data>/update-timings.json` (each step and when it ended), which the Updates page shows.
3. **Updater.** Refuses a data folder that is a link. Deletes the flag first (never opening it), takes `update.lock`, recovers any interrupted update, then, writing each step to `update-status.json`:
   1. asks for the latest stable release; equal or older means `up-to-date`;
   2. downloads and verifies the manifest with the compiled key (signature, target, newer-only, `minimumLauncher`, archive name, size and hash format);
   3. downloads the archive into `releases/<version>.download` within the signed size, checks size and SHA-256, unpacks it into `releases/<version>.incoming` under the archive rules, checks `VERSION` and `app/package.json`, and renames it to `releases/<version>`;
   4. stops the service and copies `lookstow.db` (and a `-wal` if left) to `<data>/backups/pre-update-<from>-to-<to>.db`;
   5. writes the switch record (`from`, `to`, `step: switching`, a new nonce, `rollbackCompatible`), then repoints `current`;
   6. runs the new release's `install --refresh-units`, records `step: starting`, deletes `ready.json`, starts the service;
   7. waits up to **120 s** for `ready.json` with the record's nonce and the new version;
   8. **healthy:** deletes the record, keeps the previous release, prunes the others, records `healthy`;
   9. **not healthy and `rollbackFrom` names the old version:** records `rolling-back`, stops, repoints `current` to the old release, refreshes its units, starts it, records `rolled-back`;
   10. **not healthy otherwise:** stops the service, leaves `current` on the new release, records `failed` with instructions naming the database copy. The database is never replaced automatically.
4. **Interruption.** `lookstow-recover.service` runs `update --recover` at boot before `lookstow.service` (only when the switch record exists). Rules: `switching` → back to `from` (`failed`, the new release never ran); `starting` and compatible, or `rolling-back` → back to `from` (`rolled-back`); `starting` and not compatible → `to` stays (`failed`). The path or task updater applies the same rules, stopping and starting the service around them. Every step can be repeated.

## 9. Security

The updater runs as root or SYSTEM and installs the code that holds every mailbox backup and the tenant's app credentials.

- The web app never gains root, Administrator or a way to choose what is installed. A compromised app can at most trigger an update to the genuine latest signed release.
- The release key stays offline; its public half is compiled into the launcher. Any signature, version, target, size, hash or archive problem refuses the release. There is no unsigned fallback.
- In the data folder (owned by the service account) the updater never follows a link (`O_NOFOLLOW`; `FILE_FLAG_OPEN_REPARSE_POINT` on Windows), reads only small bounded files, replaces files by rename, and refuses a linked data or `backups` folder. The switch record and lock live in the root-only program folder because recovery acts on them.
- The Linux unit runs as `lookstow` with `ProtectSystem=strict`, `ReadWritePaths=<data>`, `NoNewPrivileges`, private `/tmp`, no home access and `UMask=0077`.
- Data folder lockdown (I16): only the service account and administrators can open it (section 10).

## 10. Acceptance criteria

| #    | Criterion                                                                                                                                                                                                                    | Test                                                                                                                                                                       |
| :--- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I2   | `install` copies the bundle into `releases/<version>`, points `current`, creates the data folder, writes `server.env` once (new `SECRETS_KEY`, `HOST=127.0.0.1`, `PORT=8030` or `--port`) and keeps it on later runs.        | `install::tests::layout_and_units`, `config::tests::*`, `releases::tests::*`, `bundle::tests::*`, scratch test                                                             |
| I3   | `install --no-service` does the same without root, a service or a system user.                                                                                                                                               | scratch test (Linux), manual run (Windows)                                                                                                                                 |
| I4   | `run` starts the release's Node on `app/server.js` with `--env-file`, cwd `app/`, `DATABASE_PATH` and the `LOOKSTOW_*` values, and restarts it after a crash.                                                                | `launcher::tests::*`, scratch test                                                                                                                                         |
| I5   | Linux: `lookstow.service` runs `current/lookstow run --data-dir <data>` as `lookstow`, restarts on failure and writes only the data folder.                                                                                  | `service_linux::tests::*`                                                                                                                                                  |
| I6   | Windows: service `Lookstow` ("Lookstow (Microsoft 365 mailbox backup)") runs `run --service --data-dir <data>` as LocalService, starts automatically, restarts after a failure, logs to `server.log`.                        | `service_windows::tests::*`, `lookstow-service` `windows::tests::*`                                                                                                        |
| I7   | `uninstall` removes the service and program folder and keeps the data; `--purge` deletes the data (and the Linux user as root); other folders are refused.                                                                   | `install::tests::layout_and_units`, scratch test                                                                                                                           |
| I8   | `status` shows version, folders, service state, console address, last update and log.                                                                                                                                        | scratch test                                                                                                                                                               |
| I16  | Linux: data 0700 and `server.env` 0600, tightened by `install`, `install --refresh-units` and every `run`. Windows: protected DACL, SYSTEM and Administrators full control, LocalService modify, every existing child reset. | `data_privacy::tests::*`, `service_windows::tests::local_service_may_change_the_data`, `windows::tests::restricted_folders_keep_only_system_administrators_and_the_extras` |
| SU3  | The updater ignores flag contents, deletes the flag first, holds one lock and refuses linked data paths.                                                                                                                     | `updater::tests::flag_is_only_a_trigger`, `updater::files::tests::links_in_the_data_folder_are_never_followed`                                                             |
| SU4  | Verification: compiled key, target, size, hash, newer-only, stable-only, archive rules.                                                                                                                                      | `updates::manifest::tests::verification`, `updates::archive::tests::*`, `updates::download::tests::*`, `updater::tests::refused_releases_change_nothing`                   |
| SU5  | The switch repoints `current`, keeps one previous release and prunes older ones; the database is copied first.                                                                                                               | `updater::tests::switch_keeps_previous_and_prunes`                                                                                                                         |
| SU6  | Healthy within 120 s commits; unhealthy rolls back only when declared compatible, else stops with instructions; the database is never replaced.                                                                              | `updater::tests::health_commit_and_rollback_rules`, scratch test                                                                                                           |
| SU7  | Interruption at every step is recovered by `--recover`, at boot and by the updater.                                                                                                                                          | `updater::tests::recover_from_every_step`, scratch test                                                                                                                    |
| SU8  | Installer and updater make the same layout and units; `--version` reports the running release.                                                                                                                               | `install::tests::layout_and_units`, `service_linux::tests::*`, scratch test                                                                                                |
| SU12 | A scratch install updates A→B, refuses another key, rolls back a broken compatible C, stops on a broken incompatible D, and recovers.                                                                                        | `launcher/tests/scratch-update-test.sh`                                                                                                                                    |
| L1   | The CLI accepts exactly `run`, `install`, `update`, `uninstall`, `status` and their options.                                                                                                                                 | `tests::every_command_takes_the_folders_and_its_own_options`, `tests::stray_words_and_removed_commands_are_refused`                                                        |

App-side criteria (Update now, the progress view, readiness) and installer and workflow criteria belong to their own specs and must match sections 6 and 7.

## 11. As built (2026-11-18)

- **Crates.** `launcher/` is a Cargo workspace (version 0.1.0, AGPL-3.0-only, `rust-version = "1.89"`, exact dependency versions, `Cargo.lock` from BMuster's resolution). `lookstow-service`: `systemd`, `windows` (service manager, `restrict_dir`), `log_file`. `lookstow`: `main.rs`, `layout.rs`, `config.rs`, `bundle.rs`, `releases.rs`, `install.rs`, `launcher.rs`, `data_privacy.rs`, `service_linux.rs`, `service_windows.rs`, `updater/{mod,files,system,tests}.rs`, `updates/{mod,manifest,download,archive}.rs`. BMuster has no `[lints]` table or `clippy.toml`; the gate is `cargo clippy --all-targets -- -D warnings`, as there.
- **Ported unchanged in behaviour:** staged bundle swap, `releases/` and relative `current` link, switch record and lock in the program folder, readiness nonce handshake, health window, rollback rules, database copy, pruning, boot recovery, the path unit and updater units, the SYSTEM task, data lockdown, Node restart with backoff, the Windows service killing Node on stop, the `scratch-test` seams (`LOOKSTOW_UPDATE_TEST_SOURCE`, `LOOKSTOW_UPDATE_TEST_SERVICE`, `LOOKSTOW_UPDATE_TEST_HEALTH_SECONDS`) and `LOOKSTOW_EXTRA_RELEASE_KEY` at build time.
- **Dropped from BMuster:** agent builds and `RELEASES_PATH` (and `releases/` inside a bundle); the account recovery commands and `recovery.rs`; the LAN address helper and local network mode; the Windows firewall rule; `BODY_SIZE_LIMIT=16M` (BMuster's file uploads); the v0.3.x migration paths (old program folder layout, `<data>/server-updates`); the agent's rescue rules in the service crate; the setup-code hints in `status`.
- **Tested on Windows 11 natively** (`x86_64-pc-windows-msvc`, Rust 1.89.0): `cargo test` (31 `lookstow` and 4 `lookstow-service` tests, including the updater tests with real directory symlinks and `MoveFileExW`), `cargo clippy --all-targets -- -D warnings` with and without `--features lookstow/scratch-test`, and a manual `install --no-service`, `status`, an update refused without Administrator, and `uninstall --purge`. BMuster only ever ran its Windows tests under Wine.
- **Tested on Linux natively** (Ubuntu 24.04 under WSL 2, no root): the test binaries were cross-linked on Windows (clang and lld against a copy of Ubuntu's glibc) and run in WSL: all 35 `lookstow` and 2 `lookstow-service` tests pass. `cargo clippy --target x86_64-unknown-linux-gnu --all-targets -- -D warnings` is clean with and without `scratch-test`. `launcher/tests/scratch-update-test.sh` passed in full against the real launcher built with `scratch-test` and a throwaway key: install, settings kept on re-install, the Node command line, A→B healthy with a database copy, another key refused, a broken compatible release rolled back and running again, a broken incompatible one stopped with instructions naming the copy, `update --recover` finishing a rollback, uninstall and `--purge`.
- **Not yet run anywhere:** anything as root or SYSTEM: the systemd units for real (the path unit starting the updater, boot ordering of `lookstow-recover.service`, `useradd`, `chown`, `systemctl`), the Windows service, the SYSTEM scheduled task, `restrict_dir` on a real `C:\ProgramData\Lookstow`, the detached self-delete on uninstall, and the GitHub source over HTTPS. A `cargo zigbuild` glibc 2.31 build. The real app bundle (the scratch test uses a shell stand-in for Node). The Windows update flow end to end (only its unit tests ran).
- **Formatting:** `cargo fmt --check` was run with rustfmt from Rust 1.99.1, because this machine's 1.89.0 toolchain has no rustfmt binary.

## 12. Open questions

1. **Backup storage outside the data folder.** The Linux unit lets the service write only `<data>` (`ProtectSystem=strict`, `ReadWritePaths=<data>`), and on Windows LocalService can write only folders it is granted. If Lookstow stores mailbox backups elsewhere (another disk or a share), the unit needs that path in `ReadWritePaths` and the folder needs the service account's rights. Today backups must live under the data folder.
2. **`CAP_NET_BIND_SERVICE`** is kept from BMuster so a port below 1024 works; the console is on 8030 by default, so it could be dropped.
3. **Console address after install** is read from `server.env`; a wildcard `HOST` is shown as the loopback address.
