# Spec: viewing a message in the browser

## 1. Problem

A message could only be downloaded as .eml and opened in a mail program. Reviewers (on this computer or through remote access, `SPEC-REMOTE.md`) need to read a message and look at its attachments in the browser, without anything in the message running.

## 2. Design

- **Parsing on the reading thread.** The message page asks the reading thread (`work/ai-main.ts`, which also serves the AI tools) to parse the stored .eml with Lookstow's own MIME reader (`services/ai/mime.ts`); it keeps the last four parsed messages, so the body and its attachments do not parse the file again. A forwarded email inside a message is opened as its own page (`/messages/<id>/forwarded/<part>`).
- **The body** (`/messages/<id>/body`) is a whole document in a sandboxed frame: the HTML body with its own pictures (`cid:`) written in as data (15 MB at most), or the text body escaped in a `<pre>`. Links open in a new tab with no referrer. The frame has no `allow-scripts`, `allow-forms` or `allow-same-origin`, and the response carries a Content-Security-Policy with the same sandbox and `default-src 'none'`, so the body is locked down even opened on its own. Pictures from the internet (which tell the sender the message was read) load only after "Show pictures from the internet".
- **Attachments** (`/messages/<id>/attachments/<n>` downloads; `…/open` shows): pictures (JPEG, PNG, GIF, WebP, BMP), PDFs and text up to 2 MB are shown inline with a safe content type (text always as `text/plain`); everything else, including SVG and HTML, only downloads, as `application/octet-stream`, with `nosniff`. HEIC photos only download: browsers cannot show them, and converting them needs a library that has not been approved.
- Page responses may not be framed (`X-Frame-Options: DENY`); the body says `SAMEORIGIN` so the message page can frame it.

## 3. Acceptance criteria

| #   | Criterion                                                                  | Test                                                       |
| :-- | :------------------------------------------------------------------------- | :--------------------------------------------------------- |
| 1   | Pictures, PDFs, emails and small text preview; HEIC, SVG and HTML download | `viewer/view-message.test.ts` "shows pictures, PDFs…"      |
| 2   | No attachment is sent as something that runs                               | `viewer/view-message.test.ts` "never sends an attachment…" |
| 3   | A message's own pictures are written into its body                         | `viewer/view-message.test.ts` "writes its own pictures in" |
| 4   | A text body is shown as text, never HTML                                   | `viewer/view-message.test.ts` "shows a text body as text"  |
| 5   | The body runs nothing; internet pictures load only when asked              | `viewer/view-message.test.ts` "runs nothing"               |
