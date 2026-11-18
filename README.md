<p align="center">
  <img src="static/favicon.svg" alt="" width="96" height="96" />
</p>

<h1 align="center">Lookstow</h1>

<p align="center">Back up every Microsoft 365 mailbox to your own disk.<br />Users, shared mailboxes and online archives, found by themselves and kept even after a licence is removed.</p>

<p align="center">
  <a href="https://github.com/jackbrumley/lookstow/releases/latest"><img src="https://img.shields.io/github/v/release/jackbrumley/lookstow?label=release&color=e11d48" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-e11d48" alt="Windows and Linux" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-e11d48" alt="AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://brumley.info/lookstow/">Website</a> ·
  <a href="https://github.com/jackbrumley/lookstow/releases/latest">Downloads</a> ·
  <a href="docs/DESIGN.md">How it works</a> ·
  <a href="https://github.com/jackbrumley/lookstow/issues">Report an issue</a>
</p>

## Install

Lookstow is in early development: the first release is not out yet.

**Linux**

```bash
curl -fsSL https://brumley.info/lookstow/install.sh | sudo sh
```

**Windows** (PowerShell, run as administrator)

```powershell
irm https://brumley.info/lookstow/install.ps1 | iex
```

It installs Lookstow as a service and prints the console's address, `http://localhost:8030`, which answers on that computer only. Lookstow updates itself from signed releases.

## What it does

Lookstow is a backup service for Microsoft 365 mail that you run on your own server. It signs in to Microsoft Graph as an app, finds every mailbox in the tenant by itself, and keeps a copy of each one as plain `.eml` files any mail program can open. There are no per-mailbox licences, so there is nothing to choose between.

- Finds user mailboxes, shared mailboxes and online archives automatically, and starts backing up new ones straight away
- Incremental sync with Microsoft Graph delta queries, every 15 minutes by default
- Keeps the backup when a mailbox is deleted or loses its licence, and keeps messages deleted at the source
- A local web console: what is backed up, what is running, what failed, and every setting
- Signs in with a certificate it makes itself; the private key never leaves the server
- Updates itself from signed releases, and rolls back a release that does not start

## Build from source

Needs the Node.js version in `.node-version` and, for the launcher, Rust.

```bash
npm install
cp .env.example .env  # then set SECRETS_KEY
npm run dev           # the console at http://127.0.0.1:8031
npm run verify        # format, lint, types, tests, build
```

Contributor notes are in [AGENTS.md](AGENTS.md).

## License

AGPL-3.0. Not affiliated with Microsoft.

---

<p align="center">
  <a href="https://voquill.org/">Voquill</a> ·
  <a href="https://brumley.info/rusty-g6/">Rusty G6</a> ·
  <a href="https://somedrive.org/">SomeDrive</a> ·
  <a href="https://yambuck.com/">Yambuck</a> ·
  <a href="https://brumley.info/rawtap/">RawTap</a> ·
  <a href="https://brumley.info/comtap/">ComTap</a> ·
  <a href="https://bmuster.com/">BMuster</a> ·
  <strong>Lookstow</strong>
</p>
