# Spec: remote access (read-only, signed in, from allowed computers)

## 1. Problem

The console answered only on the computer Lookstow runs on. A compliance review keeps an HTML report whose links open messages in Lookstow (`/messages/<id>`), and the people reading it sit at other computers. They need to search, open and download backed-up messages from there, without being able to change the backup, and without single sign-on.

## 2. Design

- **A second listener.** The plain-HTTP console stays on `127.0.0.1:8030`, unchanged. Remote access adds an HTTPS listener on `0.0.0.0:<port>` (8443 unless changed), owned by `server.ts` and started, changed and stopped from Settings through a control the app finds on `globalThis` (`services/remote/listener.ts`). `server.ts` marks every request with the listener it came in on (`x-lookstow-listener`, overwriting anything a client sent). A source run (`npm run dev`) has no remote listener and says so in Settings.
- **Self-signed certificate.** Made in the app (RSA 2048, two years, the computer's name, `localhost` and its addresses as subject alternative names, `crypto/tls-certificate.ts`); its private key is sealed with `SECRETS_KEY` like the Entra certificate's. Settings shows its SHA-256 fingerprint for people to compare when their browser warns, and makes a new one on request.
- **The gate** (`services/remote/gate.ts`, called first in `hooks.server.ts` for remote requests), in this order:
  1. Remote access is on in Settings, else 403.
  2. The address is on the allow-list (IPv4 addresses, IPv4 ranges /8 to /32, exact IPv6 addresses; `domain/remote.ts`), else 403 before any page is shown.
  3. The sign-in page and the app's own files need no session. Anything else needs a session of an account that is not disabled: a page goes to `/signin?next=…`, anything else gets 401.
  4. A signed-in person may only read: GET and HEAD of the dashboard, Mailboxes, a mailbox, Search, a message (its body, attachments and downloads) and How it works; the only write is `POST /signout`. Everything else is 403. Form actions on the allowed pages are POSTs, so they are refused too.
     The Origin check on writes applies as on the local console.
- **Accounts** live in the settings table (`remote` key): a name, an scrypt hash (N 2^15, r 8, p 1, 16-byte salt), disabled or not, created and last-signed-in times. At most 20. Passwords are at least 12 characters. Settings adds, disables, enables, re-passwords and deletes them; disabling, a new password and deleting sign the person out everywhere.
- **Sessions** are random 256-bit tokens in an HttpOnly, Secure, SameSite=Strict cookie, held in memory: they end after 8 hours, after an hour without a request, at sign-out, or when the service restarts.
- **Lockout:** five wrong passwords in a row for a name, or from an address, lock it for 15 minutes. A wrong name and a wrong password get the same answer and take as long.
- **What a remote person sees:** the frame shows only Dashboard, Mailboxes, Search and How it works, "Signed in as …" and Sign out; no Pause, no update reminder, no action buttons, no picking. Before signing in, the frame's status names no mailbox, folder, path or problem (`withoutNames`).
- **Audit trail:** every remote request but the app's own files and page-data fetches is appended to `<data>/remote-audit/YYYY-MM-DD.jsonl` (time, account, address, method, path, status), and Settings shows the latest 50. Sign-ins, refusals, sign-outs and every change to remote access go to the activity log.
- **Firewall:** Lookstow does not open the firewall. Settings shows the `netsh` command (Windows) and `ufw` commands (Linux) for the port and allow-list.

## 3. Not done

- Single sign-on (Entra): not wanted; local accounts only.
- A certificate from the organisation's own authority: the self-signed one is accepted by the people using it.
- Writes from other computers (Sync now, settings): remote access stays read-only.

## 4. Acceptance criteria

| #   | Criterion                                                                                                                              | Test                                                    |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------ |
| 1   | Only listed addresses and ranges get in, however Node writes an IPv4 address                                                           | `domain/remote.test.ts` "lets in only listed addresses" |
| 2   | A remote person reads only the dashboard, mailboxes, search and messages                                                               | `domain/remote.test.ts` "reads the dashboard…"          |
| 3   | The only remote write is signing out                                                                                                   | `domain/remote.test.ts` "changes nothing"               |
| 4   | Only the sign-in page and app files open before signing in                                                                             | `domain/remote.test.ts` "shows only the sign-in page"   |
| 5   | Passwords are salted hashes; only the same password matches                                                                            | `remote/accounts.test.ts` "keeps a salted hash"         |
| 6   | Sessions end after 8 hours, an idle hour, sign-out, or for every session of an account                                                 | `remote/accounts.test.ts` "end after 8 hours"           |
| 7   | Five wrong passwords lock the name and the address for 15 minutes                                                                      | `remote/accounts.test.ts` "locks a name and address"    |
| 8   | Sign-in goes on only to a path on this site                                                                                            | `remote/accounts.test.ts` "goes on only to a path"      |
| 9   | Served over HTTPS with the made certificate; a remote request without a session is sent to sign in; Settings is refused when signed in | Smoke test of a built server (`node server.ts`)         |
