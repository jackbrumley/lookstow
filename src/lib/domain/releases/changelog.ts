/**
 * Release notes shared by the console (the Updates page) and release packaging
 * (scripts/release/notes.ts writes each GitHub release's body from its entry).
 * The newest entry comes first, and its version is the version this build runs:
 * it must equal package.json's (checked by changelog.test.ts and before a tag is
 * built). Free of package imports, so the release scripts load it with plain `node`.
 */

/**
 * What to try on real machines before trusting a release: the checks the
 * automated tests cannot make (a real Windows service, a real mailbox).
 */
type ReleaseTesting = { kind: 'none' } | { kind: 'steps'; steps: readonly [string, ...string[]] };

export type Release = {
	version: string;
	testing: ReleaseTesting;
	changes: readonly [string, ...string[]];
};

export const CHANGELOG = [
	{
		version: '0.13.6',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.13.6 from the Updates page. Expected: the countdown, then the console back by itself',
				'Open a message with photos and press one. Expected: it opens over the page, not in a new tab; the wheel or + and - zoom, dragging moves it, the rotate buttons or R turn it a quarter, the arrows or ← → go to the next picture, and Esc or a click outside closes it',
				"On the same message, press Open on a PDF. Expected: it opens in the same viewer, with the PDF's own toolbar (zoom, pages, rotate)",
				'Make an evidence pack and leave the Evidence packs page open while it is made. Expected: it reaches Ready every time (in 0.13.5 one could fail now and then with “operation not permitted”)',
				"In Settings, Remote access, press Not allowed in an account's AI tools column. Expected: it says Allowed, and a box shows three setup lines and the token, with Copy",
				"On that person's computer (an allowed address), run the three lines in Command Prompt, open a new Command Prompt and start Claude Code. Expected: /mcp lists lookstow as connected, and asking it to list the mailboxes works",
				'Press New AI token, or Allowed again to turn it off. Expected: the old token stops working at once (Claude Code shows lookstow as failed until given the new one)'
			]
		},
		changes: [
			"Pictures and PDFs open in a viewer over the page instead of a new tab: zoom, drag, rotate a quarter turn (R), flick between a message's pictures and PDFs (← →), and close with Esc or a click outside. Ctrl-click still opens a new tab",
			"AI tools from other computers: in Settings, Remote access, allow an account the AI tools and it gets its own token, with three lines to set up Claude Code on that person's computer. Read-only, from allowed computers only, and every call is logged with their name. Turning it off or making a new token stops the old one at once",
			'Fixed: an evidence pack could fail now and then (“operation not permitted”) when its page was open while it was being made'
		]
	},
	{
		version: '0.13.5',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.13.5 from the Updates page. Expected: the countdown, then the console back by itself',
				"Open a message with an iPhone photo (HEIC) attached. Expected: the photo shows in the message's pictures (the first time in a second or two); View opens it; Download gives the original .HEIC file",
				'Open Evidence packs in the side bar. Paste some message ids (or links to messages), add one made-up id, and press Check. Expected: how many were found, the made-up one listed as not in the backup, the size and the free space',
				'Give it a name and press Make the pack. Expected: it shows below with its progress, then Ready with its size and SHA-256; Download saves one .zip',
				'Unzip it in Windows. Expected: a folder with messages (each .eml opens in Outlook), manifest.csv (opens in Excel), index.html, README.txt and SHA256SUMS.txt; in PowerShell, Get-FileHash on the .zip shows the SHA-256 the page showed',
				'Ask your AI agent (Claude Code) to make an evidence pack of some messages and give you the download link. Expected: it uses create_evidence_pack and get_evidence_pack, and the pack shows on the page made by AI agent',
				'In Settings, Remote access, press Add account…, type a name and press Add (Make a password for me is ticked). Expected: a box with the address, name, password and certificate fingerprint, and Copy, which copies it all to send',
				"Press Allowed / Not allowed in the account's Evidence packs column. Expected: when allowed, that person sees Evidence packs in their side bar remotely; when not, they do not"
			]
		},
		changes: [
			"Evidence packs: one ZIP file of chosen messages to hand to a lawyer. Paste message ids or links on the Evidence packs page, check what was found, and make the pack. Each message is in it exactly as stored and checked against the fingerprint (SHA-256) taken when it was backed up, with a manifest for Excel, an index page, a README and every file's SHA-256; attachments can also go in as separate files. The ZIP's own SHA-256 shows on the page and in the activity log. Packs are kept 7 days. Downloads of several gigabytes resume if they drop",
			'AI agents can make evidence packs too (create_evidence_pack), follow them and get a download link (list_evidence_packs, get_evidence_pack)',
			'Remote accounts can be allowed to make evidence packs in Settings, Remote access (off unless you allow it)',
			'iPhone photos (HEIC) now show in the message viewer; Download still gives the original file',
			'Adding a remote account, or giving one a new password, makes a strong password for you and shows the address, name and password once, with a Copy button, ready to send'
		]
	},
	{
		version: '0.13.4',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.13.4 from the Updates page. Expected: the countdown, then the console back by itself',
				'Open any message from Search. Expected: the message itself shows on the page (From, To, date, body); its own pictures show; pictures from the internet stay blocked until you press Show them; PDFs, photos and text attachments open in the browser with View, and everything else downloads',
				'On the Dashboard, press Sync all now. Expected: the button greys out and says Syncing all… at once, the side bar says so too, and both follow the work until it ends; Discover now does the same',
				'In Needs attention, press Check again now on a mailbox. Expected: a message says how many folders are read again; after that sync, the mailbox leaves the list unless a folder really still differs',
				"In Settings, Remote access, add an account (a password of 12 or more characters), then press Change…, tick the box and enter the addresses allowed to connect. Expected: it says remote access is on, with the address to use and the certificate's fingerprint",
				'Open the firewall for those addresses with the command Settings shows (as an administrator). Then, from an allowed computer, open the address Settings shows. Expected: the browser warns about the certificate once; after accepting it, a sign-in page; after signing in, Dashboard, Mailboxes, Search and How it works only, and links from your report to /messages/… open the message',
				"From a computer not on the list, open the same address. Expected: a one-line refusal naming that computer's address, and no sign-in page",
				'Back in Settings, Remote access. Expected: Who opened what lists the remote requests, with the account and address'
			]
		},
		changes: [
			'Messages open in the browser: the message with its pictures, nothing in it ever runs, and pictures from the internet load only when you ask. Pictures, PDFs and text attachments open in the browser; anything else downloads. A forwarded email opens as its own page. iPhone photos (HEIC) still only download',
			'Remote access (Settings): people on other computers can search, open and download messages over HTTPS. Only from the addresses you allow, signed in with an account you make, and read-only: they never see Settings, the Log or any button that changes something. Every request they make is kept in an audit trail, shown in Settings. The certificate is made by Lookstow (self-signed), so each browser warns once',
			'Buttons answer at once: Sync all now and Discover now grey out and say what they are doing until the work ends, and the side bar shows it straight away instead of Idle',
			"New Check again now, in Needs attention and on a mailbox's page: reads the folders that differ from Microsoft again on a sync starting now, instead of waiting up to a day",
			'Needs attention clears sooner: a folder never fully listed is read again on the next sync, not a day after its last re-read',
			'Sync all now says that it includes online archives (it always did)'
		]
	},
	{
		version: '0.13.3',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.13.3 from the Updates page. The first start adds three indexes, so it takes a little longer than usual. Expected: the countdown, then the console back by itself',
				'Open the Dashboard. Expected: Needs attention no longer lists Sarah Croft’s online archive once its folders have had their weekly full listing (the first ones within a sync or two; all within a day), and payroll@ clears after its Inbox is next read again',
				'Open Sarah Croft’s online archive in Mailboxes. Expected: it opens in about a second (it took about 10), an Auto-expanding line says Microsoft spread it over several parts, and folders Microsoft counts short show "(one part only; its full listing … found N)"',
				'In Settings, What is backed up, tick Recoverable Items and root items and save. Expected: within a sync, folders named Recoverable Items/… and Top of Information Store appear on each mailbox’s page; where Microsoft refuses them, the Log says so once and everything else syncs as usual',
				'When a newer release comes out (after this one), open any page. Expected: a window saying it is available, with Update now, Remind me tomorrow and Skip this version, that only those buttons close; Updates in the side bar is marked New'
			]
		},
		changes: [
			'Lookstow tells you about a new release: it looks every 6 hours and at every start, and every page shows it front and centre until you choose Update now, Remind me tomorrow or Skip this version (remembered on the server, so every browser follows it). Updates in the side bar is marked New meanwhile',
			'Online archives past 100 GB (auto-expanding: Microsoft spreads them over several parts) no longer show as needing a look. Microsoft’s folder count covers only one part, so a folder it counts short is checked against its own full listing instead, every week. Exchange’s own statistics confirmed every folder of the archive that raised this was complete',
			'A full listing of an online archive folder now records items no longer in it as deleted at the source (their files stay), as mail folders already did',
			'A message deleted with Shift+Delete (moved to the hidden Recoverable Items, where Microsoft still finds it) is now recorded as deleted, instead of making the folder look one message over',
			'New option in Settings, What is backed up: Recoverable Items (deletions, purges, earlier versions and items kept for a hold) and the items in a mailbox’s or archive’s top folder. Where Microsoft refuses them for a mailbox, the Log says so once and the rest syncs as usual',
			'Faster with large mailboxes: the check after every sync for messages that left a week ago, an archive’s mailbox page, and its unreadable-items count now use indexes (each took seconds on a 330,000-item archive)',
			'Each folder on a mailbox’s page shows what its last full listing found where that differs from Microsoft’s count, and an archive’s page says how many parts it has'
		]
	},
	{
		version: '0.13.2',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.13.2 when the AI sweep has a gap (straight from 0.13.0 is fine). Expected: the usual countdown, and the console back by itself',
				'Open the Dashboard. Expected: tiles for In the backup (5 mailboxes, of 1,817 found), Fully copied (X of 5), First copy in progress (only while one is), Needs attention and Stored. A mailbox that is syncing still counts as fully copied, so the numbers stay put between sync rounds',
				'Look at First copies in progress. Expected: each mailbox still on its first copy (the online archives) with folders copied out of its total and whether it is copying now',
				'Look at Right now. Expected: one sentence (syncing N mailboxes, receiving X/s, next sync due), and archive rows in the table marked (online archive)',
				'Open the Details and Speed details sections, and Earlier problems if shown. Expected: discovery, index copy, completeness, drive, queue and throttling under Details; the speed figures under Speed details; old failures that have since cleared under Earlier problems',
				'Let the AI sweep run. Expected: the Dashboard and Mailboxes stay quick, syncing carries on, and the sweep’s searches answer faster than before'
			]
		},
		changes: [
			'The Dashboard shows lasting facts apart from what is happening now. "Waiting for first copy" counted the mailboxes syncing at that moment too, so it rose every sync round; the tiles are now In the backup (of the mailboxes found), Fully copied, First copy in progress (with folders copied), Needs attention and Stored, and a copied mailbox stays counted while it syncs',
			'A First copies in progress list shows each mailbox still on its first copy, how many of its folders are copied, and whether it is copying now',
			'Right now says in one sentence what is syncing, how fast, and when the next sync is due; online archives are marked in the table',
			'Needs attention lists each mailbox whose last sync failed or whose folder still differs from Microsoft, with what happens next. Earlier problems that have since cleared are collapsed, so old failures no longer read as current',
			'Discovery, the index copy, completeness checks, the drive, the queue, throttling and the Speed card are under collapsed Details sections',
			'The AI tools run on their own thread, so an AI agent searching all day never slows the backup engine or the console',
			'AI searches no longer count every match through the content tables when no content filter is used, and stop counting at 10,000 when one is (the reply says totalIsAtLeast). The content reader finds unread messages through its index instead of walking every row, which once took 18 s'
		]
	},
	{
		version: '0.13.1',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.13.1 from the Updates page. Expected: it installs in about the usual time',
				'Or install over the top with the one-line command in an administrator PowerShell. Expected: it says "The data folder already has Lookstow’s permissions; its files are left as they are" instead of sitting silent for many minutes, then "Starting the service...", "Waiting for Lookstow to answer...", "Lookstow is running." and the console address',
				'Open Settings and look at the AI tools card. Expected: a line saying how many messages the content index has read, of all stored (about 545,000 of 545,000)',
				'After a later update that rebuilds the search index (not this one), every page shows a banner with the count and percentage while it runs, and the Log has a line every tenth of the way'
			]
		},
		changes: [
			'Installing over the top no longer resets the permissions of every backed-up file when the data folder already has Lookstow’s permissions, which took tens of minutes with no sign of life. When it does have to (a first install over an older backup), it says why, asks you not to close the window and counts the files as it goes',
			'The installer says when it starts the service and waits for Lookstow to answer, saying every 15 seconds that it is still starting, instead of ending while Lookstow is still upgrading its database',
			'Long work after an update is shown on every page: a banner while the search index is built or the AI tools’ text index moves, with how many messages are done and the percentage, and what does not work meanwhile. The Log has a line every tenth of the way',
			'Settings, AI tools shows how many messages the content index has read of all stored, so empty photo, PDF or body searches are explained'
		]
	},
	{
		version: '0.13.0',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.13.0 the usual way. The first start adds two indexes to the database, which takes a few seconds longer than usual. Expected: the countdown stays on screen and the console comes back by itself',
				'Straight after the update, open the Dashboard, Mailboxes, Search and Activity pages a few times while backups run. Expected: each page answers in well under a second, also while the AI sweep is searching',
				'Open Mailboxes and change the State, Kind, a column sort and the page. Expected: each change shows at once, and the address keeps the choices (a reload shows the same view)',
				'Search for a word in subjects (for example timesheet), an address, and something common like re:. Expected: results in under a second; a very common text says "More than 5,000 messages"',
				'After about 15 minutes, open the Log page. Expected: lines saying the search index was built and the AI tools’ content index was moved to lookstow-content.db, and no slow-thread lines for the web thread',
				'Open http://localhost:8030/api/throughput. Expected: a threads section showing how long each thread was held in the last minute and any slow queries'
			]
		},
		changes: [
			'The console stays quick however busy Lookstow is. The backup engine, email alerts, the speed monitor, the indexes and the AI tools now run on their own thread, and the console answers from its own. Before, one busy search (like the AI sweep’s) held every page, the health check and the update check for seconds',
			'Search uses an index over subjects, senders and recipients instead of reading every message. A search answers in milliseconds instead of seconds, and finds exactly what it found before. A very common text (an address’s domain, re:) says "More than 5,000 messages" instead of counting them all',
			'The AI tools’ copy of each message’s text moved out of the main database into its own file, lookstow-content.db, with a word index. The main database, its daily copy and the copy taken before each update stay small. The text already read is moved over (starting 10 minutes after the update, a batch at a time), not read again; until then the AI tools’ body and attachment filters match nothing',
			'AI body search: a word also finds words it starts, so timesheet finds timesheets',
			'The Mailboxes page sends one page of 100 mailboxes instead of every mailbox, and its filters, sort and page are in the address',
			'Lookstow notes what makes it slow: any query that takes 100 ms or more, any minute a thread is held for a second or more, and any request over 2 seconds go to the log, and /api/throughput shows them for each thread',
			'If the backup engine’s thread ever stops unexpectedly, it starts again by itself after 5 seconds, and the console says so meanwhile'
		]
	},
	{
		version: '0.12.4',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.12.4 the usual way (this update still runs on the old page, so it may show "Unable to connect" once more)',
				'For the next update after this one: press Update now and watch. Expected: the full-screen countdown stays on screen while Lookstow restarts, with no "Unable to connect" page, and the console comes back by itself on the new version',
				'Or restart the Lookstow service with a page open (Restart-Service Lookstow in an administrator PowerShell). Expected: the page waits and carries on refreshing once Lookstow is back, instead of showing "Unable to connect"'
			]
		},
		changes: [
			'An update (or any restart of Lookstow) no longer drops the browser onto an "Unable to connect" page. Every page refreshes its live status every few seconds; while Lookstow was stopped, that refresh failed and the browser reloaded the page into the error. Pages now check that Lookstow answers before refreshing, and wait while it is away'
		]
	},
	{
		version: '0.12.3',
		testing: {
			kind: 'steps',
			steps: [
				'While Sarah Croft’s online archive is copying, open the dashboard. Expected: the Speed card’s first tile, Receiving, shows the data arriving from Microsoft (about 1–2 MB/s) even before any email of the current batch is stored; messages stored are shown under it',
				'Open Sarah Croft’s online archive in Mailboxes. Expected: First full copy says how many folders are copied, in progress and still to start',
				'Over the next hour, watch the same page. Expected: the folders still to start go down; a very large item that Microsoft will not send is listed under Items that could not be copied instead of holding up the rest'
			]
		},
		changes: [
			'The Speed card shows what is arriving from Microsoft as it arrives. An online archive export reply can take minutes, and before, the card read 0 until the whole reply was in, so a busy archive copy looked stuck',
			'Very large online archive items (25 MB or more) are exported on their own, after the rest of their folder, and asked for once per sync. If Microsoft cuts one off, it is listed under Items that could not be copied and tried again later, instead of holding up the folder for several long attempts',
			'A mailbox whose first copy is not finished says how far it has got: folders copied, in progress and still to start'
		]
	},
	{
		version: '0.12.2',
		testing: {
			kind: 'steps',
			steps: [
				'Open Sarah Croft’s online archive on the Mailboxes page and wait for a sync. Expected: its first copy carries on and finishes instead of failing with "reply broke off"; any item Microsoft cannot export is listed under Items that could not be copied',
				'On the dashboard, a mailbox that fails because a reply broke off is counted as network, not Microsoft error',
				'Open Mailboxes. Expected: only mailboxes in the backup are listed, and the State list’s Every mailbox shows the rest. The note about picked mailboxes is a quiet line, not a warning',
				'On the dashboard, follow a link on the Completeness line. Expected: Mailboxes opens showing only those mailboxes',
				'Open a mailbox with a difference. Expected: one line per folder saying what is missing, what Lookstow is doing about it and when it last checked; PersonMetadata shows Not compared after its next sync'
			]
		},
		changes: [
			'An online archive whose export replies Microsoft keeps cutting off no longer fails its whole sync. Lookstow splits the batch and tries again, down to single items; an item that still cannot be exported is listed under Items that could not be copied and tried again later, and the rest of the archive is copied. Export batches are smaller (8 MB), so replies are cut off less often',
			'A failure because a reply broke off is counted as a network failure on the dashboard, not as a Microsoft error',
			'Completeness speaks plainly. A difference is Checking while Lookstow works on it (nothing to do), Explained when items waiting to be copied again or items that are not messages account for it, and Needs a look only when it is still there a day after the folder was read again. Only Needs a look alerts',
			'Hidden folders and folders that do not hold mail (such as Outlook’s PersonMetadata) are no longer compared with Microsoft’s count',
			'Mailboxes shows the mailboxes in the backup by default; Every mailbox is one choice away. The State list can show incomplete mailboxes, and the dashboard links straight to them. The note about picked mailboxes is now a quiet line instead of a warning'
		]
	},
	{
		version: '0.12.1',
		testing: {
			kind: 'steps',
			steps: [
				'Update, then open the dashboard straight away and move between pages. Expected: pages open within a second or two, even while Lookstow links archive items and builds the AI content index in the background',
				'Watch the Log page for the first few minutes. Expected: syncs start as usual (seconds apart, not more than a minute apart)',
				'After a while, check the Activity page. Expected: an entry saying how many online archive items were linked to the same emails in their mailboxes'
			]
		},
		changes: [
			'Fixes the console being very slow after updating to 0.12.0. Linking emails to their online archive copies, which runs once after the update, read every message in the mailbox for each archive item (about 50 ms each, so minutes at a time with nothing else running). It now looks each one up directly (under 1 ms) and pauses every 100 items, so pages and syncs carry on while it runs',
			'The AI content index no longer sorts every stored message each time it reads the next 100 (about 130 ms each time on a large backup); it walks through them in order instead'
		]
	},
	{
		version: '0.12.0',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, open Settings > AI tools and leave AI tools on. Expected: within an hour, a search_messages reply from Claude shows contentIndex climbing towards the total',
				'In the Claude Code session in the timesheet workspace, ask for top_senders to payroll@ with hasPhotos. Expected: a list of farm managers with their first and last dates',
				'Ask Claude to search payroll@ with body "overtime". Expected: emails whose hours are typed in the text, with readable previews (no blank padding or "External Sender" banners)',
				'With a mailbox syncing, watch the dashboard Speed card. Expected: Allowed climbs above the old 2.84/s within about 20 minutes; with nothing syncing, Pace says Idle and "1 mailbox syncing" reads correctly',
				'Open a message from Jason’s mailbox that is older than a year (it was moved to his online archive). Expected: the message page says Moved to the online archive and links to the archive copy; it no longer says Deleted in Microsoft 365. The Activity page records how many archive items were linked',
				'Search all mailboxes for a subject you know is in both. Expected: it is listed once; choosing the archive mailbox lists the archive copy',
				'Open a page other than the dashboard while a sync runs, and wait. Expected: the side bar’s Backing up line changes when the sync ends, without reloading',
				'Open a mailbox that showed a difference from Microsoft before. Expected: after its next sync, each folder either matches or names why it differs (waiting to be copied again, not messages, or a difference since a time)',
				'Open Settings > Backup folder. Expected: a stored backup shows Move…, not Change…, and the backup folder holds a .lookstow-backup file',
				'On the server, as an administrator, run lookstow backup-folder prepare on a new empty test folder, then Move to it in Settings. Expected: a banner and the card show the copy’s progress; syncs wait; the card then shows Moved and syncs carry on in the new folder',
				'After the move, choose Remove the old copy and type REMOVE. Expected: the old folder is removed, and the activity log records how many files were removed',
				'Rename the backup folder for a moment (or detach its drive). Expected: the dashboard says the backup folder is not there and no sync runs. Put it back; backups carry on within a minute'
			]
		},
		changes: [
			'AI tools search much more: words in the message text, photos (pictures of 30 KB or more, so not logos), PDFs, attachment size and up to 200 results a page, plus a new top_senders tool. Lookstow reads each message once in the background, while AI tools are on, to make this fast',
			'Message text read by the AI tools no longer carries the invisible padding mail programs add or the mail filter’s "External Sender" banner, and photos and text inside a forwarded email count as the email’s own',
			'Speed: when Microsoft slows one busy mailbox, only that mailbox slows down. Before, it slowed every mailbox and the lower pace was remembered across restarts (it had held Lookstow at under 3 requests a second). A learned limit is now forgotten after 6 hours, and the Speed card says Idle when nothing is being copied',
			'An email moved to the online archive by the archive policy is now recorded as moved to the online archive, not as deleted, and linked to its archive copy. Both copies are kept. Search lists the email once, and the message page links the two. An email that leaves a mailbox with an online archive is called deleted only if no archive copy appears within a week. Emails earlier versions marked deleted are corrected once, in the background, after the update',
			'Every page now shows the same live state, refreshed every few seconds while work runs. The side bar no longer shows what was true when the page opened',
			'The completeness check reads Microsoft’s count after each folder syncs, so mail arriving during a sync no longer shows as a difference. Items waiting to be copied again, and items that are not messages (contacts or calendar items in Deleted Items), explain a higher count and are named on the mailbox page',
			'A folder that still differs from Microsoft after half an hour is read again from the start, at most once a day. Missing mail is copied, and nothing already stored is downloaded again. If the difference lasts a day after that, it is logged and sent to a new alert: A folder stays different from Microsoft',
			'The backup can move to another drive. An administrator prepares the folder with lookstow backup-folder prepare. Then Settings > Backup folder > Move copies every file, checks each copy against the index, and switches only when all of it is checked. Backups wait during the move, and it carries on after a restart. The old copy stays until you type REMOVE, and then only files with an identical copy are deleted',
			'A .lookstow-backup marker ties the backup folder to the index. If the backup drive is not attached, backups stop with the reason instead of starting a new backup somewhere else. Change in Settings > Backup folder is now offered only while nothing is stored'
		]
	},
	{
		version: '0.11.0',
		testing: {
			kind: 'steps',
			steps: [
				'Settings > AI tools: press Change…, tick the box and save; the card says On',
				'Press Create access token: the token and a claude mcp add command are shown once. Copy the command',
				'On the server, run the command in a terminal, then start Claude Code there and run /mcp: lookstow is connected with 4 tools',
				'Ask Claude to list the mailboxes, then to search Jason’s mailbox for messages with photos from a farm manager: it finds them and can show a photo',
				'Open the data folder’s ai-audit folder: today’s file has one line for each tool Claude used',
				'Turn AI tools off: Claude’s next tool call is refused'
			]
		},
		changes: [
			'AI tools: an AI agent on the server, such as Claude Code, can now search the backup, read messages and look at their attachments, through an MCP endpoint at http://127.0.0.1:8030/mcp. This is for reviews such as finding timesheets sent to payroll',
			'It is off until turned on under Settings > AI tools, needs an access token made there (only its fingerprint is kept), and answers only on the server itself. It can only read: nothing in the backup can be changed, deleted or sent',
			'Four tools: list mailboxes; search messages by mailbox, sender, recipient, subject, folder and date (optionally with each message’s attachments and the start of its text); open a message with its text and attachment list; and open an attachment (photos up to 1 MB are shown to the agent, anything else is downloaded from its link with the token)',
			'Online archive items are read the same way, converted from their .fts files',
			'Every message and attachment an agent opens is written to an audit log (the ai-audit folder in the data folder, one file a day), and each is named by Lookstow’s id and its SHA-256, so findings can be traced back to the backup'
		]
	},
	{
		version: '0.10.0',
		testing: {
			kind: 'steps',
			steps: [
				'Press Update now: the whole screen shows only the update, counting down from about 3 minutes, and the console comes back by itself on the new version',
				'Settings > Schedule: if Mailboxes at once still says 8 (your saved value from before), set it to 32; Lookstow now adds mailboxes by itself while Microsoft has room and stays below that',
				'Settings has a Speed card with the pace Lookstow has learned; Forget what was learned… resets it (no need to use it now)',
				'Press Sync all now and watch the dashboard for 10 minutes: Syncing goes above 3 mailboxes as Lookstow adds them, and the Speed card shows the pace',
				'Open a mailbox with many messages: if any message could not be copied, an Items that could not be copied card lists it, with Try again now; the rest of the folder copies regardless',
				'If a mailbox fails (for example a permission is missing), the dashboard shows a Failing line with the kind of failure, and that mailbox is tried again after 30 seconds, then less often up to every 15 minutes'
			]
		},
		changes: [
			'Updating now takes over the whole screen until the new version is running, so nothing is started that the restart would cut off, and the countdown starts at 3 minutes (what updates take)',
			'Mailboxes at once is decided by the governor: Lookstow adds a mailbox every 10 seconds while every slot is busy, mailboxes are waiting and Microsoft has room, and adds none while Microsoft asks it to slow down. The most at once is now 32 by default',
			'One message that cannot be copied no longer stops its folder: it is recorded, the folder goes on, and it is tried again after 15 minutes, an hour, 4 hours, then daily. The mailbox page lists such items with Try again now. Online archive items work the same way',
			'Messages are written to disk as they download, so a large message no longer has to fit in memory; each mailbox copies three folders at once, fetching the next page while the current one downloads',
			'After Microsoft restarts a folder’s change list, Lookstow checks which stored messages are no longer in the folder, so deletions are not missed',
			'A mailbox whose sync fails is tried again after 30 seconds, doubling to at most 15 minutes, and the dashboard says how many mailboxes are failing and why (permission, network, disk, Microsoft, slowed down)',
			'Settings has a Speed card: the pace Lookstow has learned from Microsoft, and Forget what was learned',
			'The pace settles at 90% of the rate Microsoft refused (was 85%), and saves no burst of requests during a pause: tested against a simulated Microsoft, it now holds 91–94% of the limit with one refusal an hour, where before it could be cut five times in a row'
		]
	},
	{
		version: '0.9.0',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, the dashboard shows a Speed card: download rate, requests a second against what Microsoft allows, requests in flight, and whether Microsoft has asked Lookstow to slow down',
				'Open http://127.0.0.1:8030/api/throughput: the same numbers as JSON, with mailboxes shown only as mailbox-1, mailbox-2 and so on',
				'Press Sync now on Jason’s online archive: its download rate is well above the 2.8 MB/s seen before (several export batches now run at once)',
				'Leave it syncing for an hour: the Speed card’s Pace climbs while Microsoft allows it; if Microsoft throttles, Pace changes lists one cut and the pace holds just under the limit',
				'Restart the service (or update again): the Speed card starts at the pace it had learned, not from the beginning'
			]
		},
		changes: [
			'A throughput governor paces every request to Microsoft: each mailbox runs as many requests at once as Microsoft allows, and the app as a whole climbs to the fastest pace Microsoft accepts, settles just under it when Microsoft asks it to slow down, and remembers that pace across restarts',
			'Online archives export several batches at once instead of one, within a memory budget, so a large archive copies several times faster',
			'When Microsoft asks for a pause, every request to that mailbox (or the whole app) waits it out together, then one request checks before the rest resume, so the pause is not made longer',
			'Requests that get no reply in 30 seconds, and downloads that stall for 60 seconds, are stopped and tried again instead of holding a mailbox for good; signing in happens once for all requests, and again once if Microsoft withdraws a token',
			'The dashboard has a Speed card, and http://127.0.0.1:8030/api/throughput gives the same numbers as JSON; a history of them, sampled every 10 seconds, is kept for 7 days in the data folder (no addresses, names or ids)',
			'This release also brings 0.7.0 and 0.8.0, which were not published on their own'
		]
	},
	{
		version: '0.8.0',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, wait for a sync of a backed-up mailbox, then open its page: the Folders table has a Microsoft says column with Microsoft’s count for each folder',
				'Where a folder’s count differs from the stored messages, it is marked, and a note under the table says why small differences are normal',
				'Open the dashboard: Completeness says every checked folder matches, or how many mailboxes differ. If some differ, open Mailboxes and tick Differs from Microsoft to list only those'
			]
		},
		changes: [
			'Lookstow now checks that each backup is complete: after every sync it records how many items Microsoft says each folder holds, and shows that beside the number it has stored. Folders that differ are marked on the mailbox page, the dashboard says how many mailboxes differ, and Mailboxes can list only those',
			'The numbers are shown as they are, with no alert yet: small differences are normal (mail arriving during a sync, and items in a mail folder that are not messages). Alerts will follow once real numbers show which differences matter'
		]
	},
	{
		version: '0.7.0',
		testing: {
			kind: 'steps',
			steps: [
				'A few minutes after the update, open the backup folder: it holds a .lookstow-index folder with one lookstow-<today>.db file, and the dashboard shows Index copy with today’s time',
				'Open Settings > Backup folder: Index snapshots shows the last copy, its size and the folder. With the default backup folder it also says the copies are on the same drive as the index',
				'Open How it works in the side bar: it shows this computer’s own sync interval, backup folder and index copy folder, and the steps to put a copy back',
				'Open an online archive’s mailbox page: if any item could not be read for Search, it says how many under Not readable. Restart the service: the Log does not repeat the same warning for those items',
				'Optional: open Alerts and tick The index cannot be copied for someone, so a failed copy is emailed'
			]
		},
		changes: [
			'Lookstow copies its index to the backup drive once a day and keeps the newest 7. The index records every message’s folder and history; if it is ever lost, putting back a copy loses at most a day of history instead of all of it, and nothing is downloaded twice. How to do it is on the new How it works page and in the README',
			'A failed copy is an error under Recent problems on the dashboard, and an email alert you can turn on (The index cannot be copied). Lookstow tries again every hour',
			'New How it works page: what Lookstow copies and when, how online archives and dates work, what happens when mail is moved or deleted in Microsoft 365, and how to restore the index, with this computer’s own folders and schedule',
			'An online archive item Lookstow cannot read is tried once per version, not at every start. Its mailbox page says how many could not be read; they stay stored as they came'
		]
	},
	{
		version: '0.6.2',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, Activity soon says how many online archive items were filed under the month they were received (Log names any that could not be moved)',
				'In C:\\ProgramData\\Lookstow\\mailboxes, Jason’s archive folder now holds years like his mailbox’s (2018, 2019 …), and an item’s file date matches its received date in Search',
				'Open an archive item from Search and download it again: both the .eml and the original .fts still work',
				'In Settings > What is backed up > Change, and in a mailbox’s Exclude or Delete backup: each radio button sits level with its text'
			]
		},
		changes: [
			'Online archive items copied before 0.6.0 are moved, once, to the month they were received, so an archive’s folders match its mailbox’s. The files are renamed on the same drive and are otherwise unchanged',
			'Radio buttons and checkboxes everywhere line up with the first line of their text'
		]
	},
	{
		version: '0.6.1',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, open Settings: What is backed up says how many mailboxes that are not backed up still have backups, and their size (15 mailboxes on the test machine)',
				'Open What is backed up > Change, leave the mailboxes as they are, choose Delete them from the backup drive, type DELETE and Save: the toast says how many backups were deleted, and the mailboxes folder on the backup drive holds only the mailboxes you back up',
				'Open Activity: one Backup deleted entry for each of those mailboxes, and a What is backed up was changed entry saying how many were deleted',
				'Open the mailbox page of a mailbox whose first copy was cut off before (abby.aguinaldo@midfield.com.au): before deleting, it showed its real message count and a Delete backup button'
			]
		},
		changes: [
			'What is backed up: Delete now deletes the backup of every mailbox that is not backed up, also those left out by an earlier change. Before, it only covered mailboxes that stopped in that same save, so choosing it later deleted nothing and said nothing',
			'A mailbox whose first copy stopped part-way now shows its real message count. Before, it showed 0 until a sync finished, which hid its backup from Delete backup, Search this mailbox and the What is backed up choice. Counts left wrong by earlier versions are corrected at start-up',
			'Settings shows how many mailboxes that are not backed up still have backups on the drive, and their size'
		]
	},
	{
		version: '0.6.0',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, Activity soon says how many online archive items stored earlier can now be found in Search (Log names any that could not be read)',
				'In Search, pick Jason’s online archive as the mailbox and search for a sender or a word in a subject: archive items come back with their subject, sender and received date',
				'Open an archive item and press Download .eml: it opens in Outlook with its body, inline pictures, attachments, and any attached email',
				'Download the original (.fts) of the same item: it is the file exactly as Microsoft exported it',
				'Press Sync now on the archive: items copied from now on are filed under the year and month they were received'
			]
		},
		changes: [
			'Online archive items can be read: Lookstow reads Exchange’s full-fidelity export itself, so Search finds archive items by subject, sender, recipients, date and Message-ID, like normal mail',
			'Download .eml for any archive item: a copy that Outlook and other mail programs open, with the body, inline pictures, attachments and attached emails. The original .fts file is kept unchanged and can still be downloaded',
			'Archive items copied from now on are filed by the date they were received, not the date they moved into the archive (often two years later). Items copied earlier keep their place on disk and are found by their received date in Search'
		]
	},
	{
		version: '0.5.1',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, open the online archive’s mailbox page (Jason Shaw (archive)) and press Sync now: its message count grows, and Log shows no "Bad control character" error',
				'When the archive’s first copy is done, its page says First full copy: Done, and Search with that archive as the mailbox lists its items by date'
			]
		},
		changes: [
			'Online archives: copying no longer stops at an item whose export reply holds a raw control character. Microsoft’s export API sends such replies, and Lookstow refused them, so the archive stayed stuck at the same batch'
		]
	},
	{
		version: '0.5.0',
		testing: {
			kind: 'steps',
			steps: [
				'Open Alerts > Sending email > Set up: enter the Mailgun sending domain (as i12-pt6-control uses), the region and a sending key, then Save',
				'Add yourself under Who gets alerts, tick every alert, and press Send a test: the toast says Sent, and the email arrives',
				'Change the key to a wrong one and Send a test: the toast says Mailgun refused it and what to check; put the right key back',
				'Pause a mailbox you picked, then Resume it and press Sync now on its archive while the archive permissions are missing (or wait for a real failure): an alert email names the mailbox and Microsoft’s reason',
				'Check the Emails list on the Alerts page: every email shows Sent, Waiting to retry, Failed or Not sent, with the reason'
			]
		},
		changes: [
			'Email alerts, as in I12 and PT6 Control: sent through Mailgun to the people you choose, each with the alerts they want: a mailbox failing or syncing again, discovery failing, the backup drive full, mailboxes found or gone, a first copy finished, backups deleted or the mailboxes backed up changed, and automatic updates',
			'A new Alerts page: the Mailgun setup (the key is stored sealed and never shown), who gets which alerts, a test email for each person, and every email with its result',
			'A failed send is tried again after 1, 5, 15 and 30 minutes, then hourly, so a Mailgun outage delays an alert instead of losing it'
		]
	},
	{
		version: '0.4.4',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.4.4, then open Updates > Last update: "downloaded and unpacked" and "started the new release" each take seconds, not a minute',
				'On a mailbox page, press Search this mailbox: Search opens with that mailbox filled in, with no error',
				'In Search, type an address two mailboxes share: the list shows it once, and the search covers the mailbox still in Microsoft 365',
				'If the update did not start within seconds, Log shows "Could not start the updater task at once" with the reason on the same line'
			]
		},
		changes: [
			'Updates: the update archive holds a few hundred files instead of about 4,000, so unpacking takes seconds',
			'Updates on Windows: the data folder’s permissions are checked, and reset across every backed-up file only when they changed, instead of on every update',
			'Search: Search this mailbox no longer fails with an error when two mailboxes share an address',
			'The log gives the full reason when the updater cannot be started at once'
		]
	},
	{
		version: '0.4.3',
		testing: {
			kind: 'steps',
			steps: [
				'After the update, the dashboard shows Moving files with a count while files stored before 0.4.0 move into the date layout; syncs start when it finishes',
				'In the backup folder, each mailbox holds only year and month folders; the old Inbox, Sent Items and other mail-folder folders are gone',
				'Search finds an old message and its download still opens',
				'In Search, type two or three letters of an address in Mailbox: the list narrows to matching mailboxes, and the field no longer covers Words'
			]
		},
		changes: [
			'Files stored before 0.4.0 are moved once into the date layout (mailbox/year/month); which folder each message is in is kept only in the database. The move renames files on the same drive, so it is quick and the files are unchanged',
			'Search: the Mailbox field is a box you type into, with a list that narrows as you type, and it stays inside its column'
		]
	},
	{
		version: '0.4.2',
		testing: {
			kind: 'steps',
			steps: [
				'Update to 0.4.2 (this update still waits for the old two-minute task; it installs the new one)',
				'On the Updates page, Last update lists how long each step took',
				'When the next release is out, press Update: the updater starts within seconds (Log says "Started the updater task"), and Last update shows the steps'
			]
		},
		changes: [
			'Windows: the console starts the updater the moment you press Update, instead of waiting up to two minutes for its timer; the timer now also runs every minute as a fallback',
			'Windows: the updater also runs on battery (it did not start on battery before), and never twice at once',
			'The Updates page shows how long each step of the last update took: the wait, download and unpack, stopping the service, the database backup and the start'
		]
	},
	{
		version: '0.4.1',
		testing: {
			kind: 'steps',
			steps: [
				'Settings > Test connection shows an Online archive permissions step: it lists any of the three archive permissions not granted yet',
				'After adding them and granting admin consent, Test connection passes that step, and the next archive sync copies items',
				'Open Log: every failed sync now has a line, and archives are named "(online archive)"'
			]
		},
		changes: [
			'A reply from Microsoft that is cut off, garbled or ends early is asked for again, instead of failing the mailbox ("terminated", "invalid bit length repeat", "Unexpected end of JSON input")',
			'A timeout while signing in to Microsoft Entra is retried, instead of failing the mailbox',
			'Test connection shows which online archive permissions Microsoft has granted, and which are missing',
			'The log shows every failed sync, not only the first of a run of failures, and names online archives as such (here and on the dashboard)'
		]
	},
	{
		version: '0.4.0',
		testing: {
			kind: 'steps',
			steps: [
				'In Entra, add the application permissions MailboxFolder.Read.All, MailboxItem.Read.All and MailboxItem.Export.All to the Lookstow app and grant admin consent',
				'Pick a mailbox that has an online archive: its archive syncs too, and its page lists the archive folders and a growing message count',
				'Without those permissions, the archive fails with a message naming them, and the mailbox itself still syncs',
				'Open Search: find a message by sender, by To, by subject words and by date; open it, see its history, and download the .eml (it opens in Outlook)',
				'Move a message to another folder in Outlook, sync the mailbox, and its history shows the move; its file stays where it was'
			]
		},
		changes: [
			'Online archives are copied, auxiliary (auto-expanded) archives included, through Microsoft’s mailbox export API. Each item is stored as Exchange’s full-fidelity export (.fts). This needs three more Graph permissions: see the testing steps',
			'New messages are filed by date (mailbox/yyyy/mm/date_subject_id.eml) and never move again; folder moves, deletes and restores are kept as each message’s history. Files stored by earlier versions stay where they are',
			'Search: find stored messages by words, sender, To or Cc, subject, folder, Message-ID, date and mailbox, then open one to see its details and history and download it',
			'A mailbox stopped by Pause or a restart starts again at once instead of waiting for its next turn',
			'The dashboard shows how many mailboxes wait for their next turn, and when the next one is due',
			'The Updates page follows an update started anywhere (automatic ones too) and reloads when it is installed; any open page offers a reload when a new version is running'
		]
	},
	{
		version: '0.3.0',
		testing: {
			kind: 'steps',
			steps: [
				'With a few mailboxes syncing, the dashboard shows a download rate that moves, and how many mailboxes sync at a time',
				'Press Discover now: the dashboard counts users checked and mailboxes found while it runs',
				'Open Log: new lines appear every two seconds; search, the level filter and Copy work',
				'With many mailboxes picked, watch Microsoft throttling on the dashboard: when it appears, fewer mailboxes sync at once',
				'On Mailboxes, sort by Size and move between pages; on Activity, Older entries pages back'
			]
		},
		changes: [
			'Live download rate (MB/s and messages/s, last minute and last 15 minutes) and Microsoft throttling on the dashboard',
			'Lookstow adjusts how many mailboxes sync at once: more while Microsoft allows it, fewer when it asks to slow down (Settings sets the most, now up to 32)',
			'Discovery shows its progress: users checked and mailboxes found so far',
			'A Log page: the service log, live, with search, a level filter and copy',
			'Mailboxes sort by any column and come in pages of 100; Activity pages back with Older entries'
		]
	},
	{
		version: '0.2.0',
		testing: {
			kind: 'steps',
			steps: [
				'Press Pause at the side of any page while mailboxes sync: they stop within a page of messages, and Resume carries on where they stopped',
				'On a mailbox page, Pause and Resume just that mailbox',
				'Exclude (or Unpick) a mailbox that has a backup: choose Keep, then try again on another with Delete and the address typed; the files are gone and Activity says so',
				'In Settings > Disk space, set the pause limit below how full the drive is now: backups pause with a red banner and Resume refuses until the limit is raised',
				'With a large first copy running, a mailbox already backed up still syncs on its own timer'
			]
		},
		changes: [
			'Pause and Resume for everything, from any page, and for each mailbox on its page',
			'Disk guard: a warning at 85% of the backup drive and an automatic pause at 90% (both in Settings), shown on the dashboard',
			'Excluding or unpicking a mailbox, or changing what is backed up, asks whether to keep or delete the backups it had; deleting needs a typed confirmation',
			'Each mailbox now syncs on its own timer, and first copies never take every slot, so mailboxes already backed up keep syncing during a long first copy',
			'The dashboard shows what is syncing, what is waiting in each queue, discovery and the backup drive'
		]
	},
	{
		version: '0.1.1',
		testing: {
			kind: 'steps',
			steps: [
				'From 0.1.0, let the install update itself (or choose Update now): the Updates page reloads into 0.1.1',
				'Settings > What is backed up > Only the mailboxes I pick, then Pick two mailboxes on the Mailboxes page: only those two are copied',
				'Test connection on a tenant whose first users have no mailbox: it skips them and passes, naming the mailbox it tested on',
				'Move between pages after finishing the setup: the "Enter the tenant ID" banner is gone everywhere'
			]
		},
		changes: [
			'Back up only the mailboxes you pick: Settings > What is backed up, then Pick on the Mailboxes page',
			'Test connection skips users without a mailbox (inactive, soft-deleted or on-premises) instead of failing on them',
			'Discovery starts as soon as Microsoft 365 is connected, not hours later',
			'The page frame refreshes on every page, so an old setup warning no longer lingers; the dashboard says when a sync of every mailbox is running',
			'An empty reply from Microsoft Graph is asked for again instead of failing the mailbox',
			'The app icon sits on a light tile in the sidebar, so it stands out'
		]
	},
	{
		version: '0.1.0',
		testing: {
			kind: 'steps',
			steps: [
				'On a fresh Ubuntu or Debian machine, run the install command from https://brumley.info/lookstow: it ends by printing http://127.0.0.1:8030, and that address opens the console',
				'In an administrator PowerShell on Windows 10 or 11, run the install command: the Lookstow service is running and http://127.0.0.1:8030 opens the console',
				'Run the install command again on both: the data and the secrets key are kept',
				'Uninstall with the command the installer printed, then with --purge: the program folder, and then the data folder, are gone'
			]
		},
		changes: [
			'First release: Lookstow backs up Microsoft 365 mailboxes, shared mailboxes and online archives to a folder on this computer, as a service for Windows and Linux with a console at http://127.0.0.1:8030',
			'One-line installers for Linux and Windows, and signed automatic updates of the whole install from the console'
		]
	}
] as const satisfies readonly [Release, ...Release[]];
