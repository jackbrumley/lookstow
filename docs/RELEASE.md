# Releasing Lookstow

How a Lookstow release is made, signed, tested and published, and how installed copies pick it up. The design is BMuster's whole-install updater, renamed.

## What a release is

One GitHub release, tagged `vX.Y.Z`, with these files:

| File                                           | Used by                                                           |
| :--------------------------------------------- | :---------------------------------------------------------------- |
| `lookstow-app-x86_64-unknown-linux-gnu.tar.gz` | `install.sh` and the Linux updater: the whole install             |
| `lookstow-app-x86_64-unknown-linux-gnu.json`   | its signed manifest                                               |
| `lookstow-app-x86_64-pc-windows-msvc.tar.gz`   | the Windows updater: the whole install                            |
| `lookstow-app-x86_64-pc-windows-msvc.json`     | its signed manifest                                               |
| `lookstow-windows-x64.zip`                     | `install.ps1` (a `lookstow` folder; checked against `SHA256SUMS`) |
| `SHA256SUMS`                                   | `install.ps1`, and anyone checking a download by hand             |

Asset names carry no version, so the installers fetch `https://github.com/jackbrumley/lookstow/releases/latest/download/<name>` without calling the GitHub API.

Each bundle holds, at the top level: `lookstow` (`lookstow.exe`), the launcher; `node/`, the Node runtime pinned in `.node-version`; `app/` (`server.js`, `build/`, `node_modules/` for that platform, `package.json`, `src/lib/server/database/migrations/`); `VERSION`; `LICENSE`. The launcher's updater refuses any other top-level name.

### The signed manifest

`lookstow-app-<target>.json` is `{"payload":"<base64>","signature":"<base64>"}` on one line. The signature is Ed25519 over `LOOKSTOW-SERVER-UPDATE-1\n` followed by the payload bytes. The payload is:

```json
{
	"schemaVersion": 1,
	"version": "0.1.0",
	"target": "x86_64-unknown-linux-gnu",
	"archive": "lookstow-app-x86_64-unknown-linux-gnu.tar.gz",
	"bytes": 61234567,
	"sha256": "<64 hex>",
	"minimumLauncher": "0.1.0",
	"nodeMajor": 26,
	"rollbackFrom": []
}
```

`minimumLauncher` and `rollbackFrom` come from `docs/server-update-compatibility.json`:

- **minimumLauncher**: the oldest installed version whose updater may install this release by itself. Older installs are told to run the installer again.
- **rollbackFrom**: the versions that run correctly on the database this release leaves. If the new release does not report ready within 120 seconds, the updater goes back to the previous release only when it is listed here; otherwise it stops and names the pre-update database copy.

Migrations are additive only, so `rollbackFrom` can usually list the previous release.

## The release key

One Ed25519 key signs every manifest. Its public half is in three places, kept equal by `npm run release:key -- --check` (run by CI and the release workflow):

- `launcher/crates/lookstow/release-key.pub` (raw 32 bytes, base64): compiled into the launcher's updater.
- `RELEASE_PUBLIC_KEY` in `src/lib/server/services/server-updates/release.ts`: the console's update check.
- `RELEASE_KEY_PEM` in `docs/install.sh`: the installer's check (needs OpenSSL 3).

The private half is the `LOOKSTOW_RELEASE_KEY` secret of the repository, and otherwise offline. `npm run release:key` makes a new pair once: it writes the private key to `keys/lookstow-release-key.pem` (ignored by git) and the public key to all three places. Then:

```sh
gh secret set LOOKSTOW_RELEASE_KEY < keys/lookstow-release-key.pem
```

and move the file somewhere offline. A new key means every installed copy refuses updates until the installer is run on it again, so replace the key only if it is lost or leaked.

## Making a release

1. Start from an up-to-date `dev` with `npm run verify` green and the launcher's gate green (`cd launcher && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`).
2. Bump the version in `package.json` and in `launcher/Cargo.toml` (`[workspace.package] version`). They are always equal.
3. Add the release at the top of `src/lib/domain/releases/changelog.ts`: `changes` in plain words, and `testing` with the steps to try on real machines (or `{ kind: 'none' }`). The newest entry is the version the app reports, and it becomes the GitHub release notes (`npm run release:notes -- vX.Y.Z` prints them).
4. Add the release to `docs/server-update-compatibility.json` with `minimumLauncher` (normally the previous `minimumLauncher`) and `rollbackFrom` (normally the previous release).
5. Optional dry run: `gh workflow run release.yml --ref dev`. It builds, signs and tests everything and keeps the files as workflow artifacts, without publishing.
6. Merge to `main`, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
7. The release workflow (`.github/workflows/release.yml`) then:
   - **check**: the tag equals `v` + both versions, the changelog has the entry, the key copies agree;
   - **launcher**: builds `lookstow` for Linux (with `cargo zigbuild` against glibc 2.31, checked with `objdump`) and Windows (MSVC);
   - **package**: on native runners, builds each bundle (`scripts/release-server.ts --launcher …`) and signs its manifest with the secret (`scripts/server-update-sign.ts`);
   - **sums**: writes `SHA256SUMS`;
   - **install-test-linux** and **install-test-windows**: installs with this commit's installers, waits for `/readyz` on `127.0.0.1:8030`, checks the console is not on the network, refuses a tampered archive (Linux), upgrades and checks `SECRETS_KEY` is kept, then uninstalls with `--purge`;
   - **update-test-linux**: the scratch update test (below);
   - **publish**: only for a tag and only when every test passed, creates the GitHub release with every file at once.
8. Try the release's "What to test on real machines" steps.

Installed copies check GitHub's latest stable release daily (and on Check now in the console). Update now writes an empty `update-requested` file in the data folder; the launcher's updater, running as root or SYSTEM, does the rest.

## Building and testing locally

| Task                                       | Command                                                                         |
| :----------------------------------------- | :------------------------------------------------------------------------------ |
| This computer's release in `dist/release/` | `npm run release:local` (builds the launcher with cargo)                        |
| Sign its manifest                          | `npm run release:sign -- --target <target> --key keys/lookstow-release-key.pem` |
| Release notes for a tag                    | `npm run release:notes -- vX.Y.Z`                                               |
| Check a tag before pushing it              | `node scripts/release-check.ts vX.Y.Z`                                          |
| Check the key copies                       | `npm run release:key -- --check`                                                |
| Scratch update test (Linux only)           | `npm run release:update-test`                                                   |

To try a local Linux build without systemd: unpack `dist/release/lookstow-app-x86_64-unknown-linux-gnu.tar.gz` into a folder and run its `./lookstow install --prefix <scratch>/opt --data-dir <scratch>/data --no-service`, then `<scratch>/opt/current/lookstow run --data-dir <scratch>/data`, and open `http://127.0.0.1:8030`. With the signed manifest beside the archive, `sh docs/install.sh --archive <archive> --no-service --prefix … --data-dir …` does the same through the installer's signature check. On Windows: `.\docs\install.ps1 -Archive dist\release\lookstow-windows-x64.zip -NoService -Prefix … -DataDir …`.

The scratch update test builds the launcher with the `scratch-test` feature and a throwaway key (`LOOKSTOW_EXTRA_RELEASE_KEY`), installs stand-in release A into scratch folders, and asks the updater, as Update now does, to move to B (healthy, kept), C (signed by another key, refused), D (never ready, declares B compatible, rolled back) and E (never ready, incompatible, stopped with a database copy), then recovers an interrupted rollback.

## Where things live on an installed computer

|         | Linux                                                       | Windows                                 |
| :------ | :---------------------------------------------------------- | :-------------------------------------- |
| Program | `/opt/lookstow/releases/<version>`, `/opt/lookstow/current` | `C:\Program Files\Lookstow`             |
| Data    | `/var/lib/lookstow` (`lookstow.db`, `server.env`)           | `C:\ProgramData\Lookstow`               |
| Service | `lookstow.service`, user `lookstow`                         | `Lookstow`, `NT AUTHORITY\LocalService` |
| Log     | `journalctl -u lookstow`                                    | `C:\ProgramData\Lookstow\server.log`    |
| Console | `http://127.0.0.1:8030`                                     | `http://127.0.0.1:8030`                 |

## GitHub settings this needs

- **Secret** `LOOKSTOW_RELEASE_KEY`: the private release key (PKCS #8 PEM).
- **Pages**: deploy from branch `main`, folder `/docs`, served at `https://brumley.info/lookstow/` (the installers' address).
- **Tags**: a tag ruleset for `v*` that only the maintainer can create, so nobody else can trigger a release.
- **Branches**: protect `main` (pull requests, CI green).
