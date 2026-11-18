# Decisions

The technical choices and their reasons. Add to it when you make one.

## Build our own instead of more Veeam licences (2026-11-18)

Veeam's per-user licence turns "what is backed up" into a list someone keeps by hand, and gaps were found. A small service that backs up whatever discovery finds removes the list. Microsoft 365 Backup (Microsoft's own, billed per GB) was considered; it keeps the copy in Microsoft's cloud, and a copy on our own disk was the point.

## Name: Lookstow (2026-11-18)

Outlook → Look**stow** ("stow": to put away safely), in the style of SomeDrive (OneDrive). Outkeep, Inlook, SomeMail and Backlook were taken; lookstow.com and lookstow.org were unregistered.

## SvelteKit service with a local web console (2026-11-18)

The maintainer wanted a console to open, monitor and act on, like ComTap's, on Windows and Linux. A web page served by the service needs nothing else installed, works on a server with no desktop session, and handles hundreds of mailboxes in tables. Tauri was considered and not chosen: a second program to install and keep in step with the service.

## BMuster's install and update architecture (2026-11-18)

Self-update and one-line install matter most. BMuster already solves both on Windows and Linux: a Rust launcher with a pinned Node runtime, signed release manifests, versioned release folders with a `current` link, a root updater the app can only trigger, health checks and rollback. Ported rather than re-invented. Chosen over i12-pt6-control's single Node executable (Windows only, updated by hand) and ComTap's update scripts (no signatures or rollback).

## Unprivileged service, privileged updater (2026-11-18)

The service reads every mailbox, so it runs as the Linux user `lookstow` or Windows LocalService, and only the updater runs as root/SYSTEM. A compromised console can at most ask for the genuine latest signed release.

## Node 26, as BMuster (2026-11-18)

Started on Node 24 (installed on the development machine), then moved to 26 to match BMuster and to move the development machines forward. `.node-version` pins 26.13.0; the release bundles that exact build, and `engines` requires 26 or newer.

## Microsoft Graph, not EWS (2026-11-18)

EWS is being retired in Exchange Online. Graph v1.0 covers primary mailboxes (folders, delta queries, MIME). Archives need the beta mailbox API (DESIGN.md section 7).

## Certificate made by the console, RS256 assertions (2026-11-18)

Client secrets expire and can be copied; a certificate's private key never leaves the server. Node can sign but not build certificates, so the DER encoder from BMuster builds an RSA 3072 self-signed certificate. Entra accepts RSA keys only for client assertions; RS256 is accepted by every tenant.

## Plain .eml files in a readable tree (2026-11-18)

A backup should be usable without Lookstow: any mail program opens .eml, and folders mirror the mailbox. The SQLite index is for sync state and the console, not the only way to find mail.

## Immutable ids and folder-aware deletes (2026-11-18)

With `Prefer: IdType="ImmutableId"` a message keeps its id when moved. A folder's delta reports a moved message as removed, so a removal marks the message deleted only if it is still filed in that folder; the destination folder's delta files it there.

## Console on this computer only, for now (2026-11-18)

Remote access needs sign-in, and sign-in is not built. Refusing other computers is safer than a console anyone on the network can open.

## Automatic updates on by default (2026-11-18)

The maintainer wants to iterate quickly. Releases are signed and roll back by themselves, so installing a new release soon after the daily check finds it is low risk. A switch in Settings turns it off.
