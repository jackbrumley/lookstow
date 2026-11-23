# Spec: viewing a message in the browser

## 1. Problem

A message could only be downloaded as .eml and opened in a mail program. Reviewers (on this computer or through remote access, `SPEC-REMOTE.md`) need to read a message and look at its attachments in the browser, without anything in the message running.

## 2. Design

- **Parsing on the reading thread.** The message page asks the reading thread (`work/ai-main.ts`, which also serves the AI tools) to parse the stored .eml with Lookstow's own MIME reader (`services/ai/mime.ts`); it keeps the last four parsed messages, so the body and its attachments do not parse the file again. A forwarded email inside a message is opened as its own page (`/messages/<id>/forwarded/<part>`).
- **The body** (`/messages/<id>/body`) is a whole document in a sandboxed frame: the HTML body with its own pictures (`cid:`) written in as data (15 MB at most), or the text body escaped in a `<pre>`. Links open in a new tab with no referrer. The frame has no `allow-scripts`, `allow-forms` or `allow-same-origin`, and the response carries a Content-Security-Policy with the same sandbox and `default-src 'none'`, so the body is locked down even opened on its own. Pictures from the internet (which tell the sender the message was read) load only after "Show pictures from the internet".
- **Attachments** (`/messages/<id>/attachments/<n>` downloads; `…/open` shows): pictures (JPEG, PNG, GIF, WebP, BMP), PDFs and text up to 2 MB are shown inline with a safe content type (text always as `text/plain`); everything else, including SVG and HTML, only downloads, as `application/octet-stream`, with `nosniff`. iPhone photos (HEIC and HEIF, up to 40 MB) show as a JPEG copy made on the reading thread with heic-convert (libheif compiled to WebAssembly; no native code), kept for the last six photos; Download always sends the original file. A photo that cannot be converted downloads instead. The release bundles define `__dirname`, which libheif-js reads (`scripts/release/app-entries.ts`).
- **The lightbox** (`ui/lightbox.svelte`): clicking a picture or a PDF opens it over the page instead of a new tab (Ctrl or a middle click still opens a tab). Pictures zoom (buttons, wheel, pinch, + - 0), rotate a quarter turn (buttons, R and Shift+R; a sideways picture is fitted to the window's height) and drag; a PDF shows in the browser's own viewer, which has its own zoom, rotate and pages. The arrows and ← → move between the message's pictures and PDFs; Esc or a click outside (not the end of a drag) closes it. Shown attachments may be framed by Lookstow's own pages only (SAMEORIGIN).
- **Times** everywhere in the console are shown in the local time of the computer Lookstow runs on (`utils/format.ts`; the root layout passes the server's zone, so the server's page and every browser agree). Stored times stay exact (UTC). A message's Date header is read as a time and shown with its zone, e.g. "9 July 2020, 8:59 am AEST"; hovering shows the header as written.
- Page responses may not be framed (`X-Frame-Options: DENY`); the body says `SAMEORIGIN` so the message page can frame it.

## 3. Acceptance criteria

| #   | Criterion                                                                          | Test                                                                               |
| :-- | :--------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| 1   | Pictures (HEIC too), PDFs, emails and small text preview; SVG and HTML download    | `viewer/view-message.test.ts` "shows pictures, PDFs…"                              |
| 2   | No attachment is sent as something that runs                                       | `viewer/view-message.test.ts` "never sends an attachment…"                         |
| 3   | A message's own pictures are written into its body                                 | `viewer/view-message.test.ts` "writes its own pictures in"                         |
| 4   | A text body is shown as text, never HTML                                           | `viewer/view-message.test.ts` "shows a text body as text"                          |
| 5   | The body runs nothing; internet pictures load only when asked                      | `viewer/view-message.test.ts` "runs nothing"                                       |
| 6   | A HEIC photo views as a JPEG; download is the original; a broken one is sent as is | `viewer/heic.test.ts`; a real iPhone photo through the release bundle (smoke test) |
