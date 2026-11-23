import type { EvidencePack } from '../../../domain/evidence-packs.ts';
import { zipSafeName } from '../../../domain/evidence-packs.ts';

/**
 * The files of an evidence pack besides the mail (docs/specs/SPEC-EVIDENCE-PACKS.md): where
 * each message goes in the ZIP, the manifest, the list of SHA-256s, the README and a plain
 * index page. Pure, so tested on their own.
 */
export type PackMessage = {
	id: string;
	mailboxAddress: string;
	mailboxKind: string;
	folderPath: string;
	subject: string;
	sender: string;
	recipients: string;
	receivedAt: Date | null;
	internetMessageId: string | null;
	filePath: string;
	sha256: string;
	storedAt: Date;
	deletedAt: Date | null;
	byteCount: number;
};

/** How a message's stored file checked out against the SHA-256 kept when it was backed up. */
export type FileCheck = 'matches' | 'converted' | 'MISMATCH' | 'MISSING';

export type ManifestRow = {
	message: PackMessage;
	/** Its .eml in the ZIP (from the pack's folder), or null when it could not be read. */
	file: string | null;
	fileSha256: string | null;
	check: FileCheck;
	attachments: number;
};

/**
 * Times in a pack are the local time of the computer Lookstow runs on, as everywhere in Lookstow,
 * and say which zone; manifest.csv keeps exact ISO 8601 UTC times as well.
 */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const LOCAL = new Intl.DateTimeFormat('en-CA', {
	timeZone: ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23'
});

function localParts(when: Date): { date: string; hours: string; minutes: string } {
	const part = (type: Intl.DateTimeFormatPartTypes): string =>
		LOCAL.formatToParts(when).find((each) => each.type === type)?.value ?? '00';
	return {
		date: `${part('year')}-${part('month')}-${part('day')}`,
		hours: part('hour'),
		minutes: part('minute')
	};
}

/** `2024-03-05 0912`, local time, so names sort by date. */
function stamp(when: Date | null): string {
	if (when === null) return 'no date';
	const local = localParts(when);
	return `${local.date} ${local.hours}${local.minutes}`;
}

/** `2024-03-05 09:12`, local time, for people to read. */
function shown(when: Date | null): string {
	if (when === null) return '';
	const local = localParts(when);
	return `${local.date} ${local.hours}:${local.minutes}`;
}

/** The mailbox's folder name in the pack: its address, and "(online archive)" for an archive. */
function mailboxFolder(message: Pick<PackMessage, 'mailboxAddress' | 'mailboxKind'>) {
	const label =
		message.mailboxKind === 'archive'
			? `${message.mailboxAddress} (online archive)`
			: message.mailboxAddress;
	return zipSafeName(label, 90);
}

/**
 * Names the messages' files: `messages/<mailbox>/<date time> <subject> [<id start>]`, unique
 * within the pack (the whole id where the start is not enough). Without the extension.
 */
export class PackNames {
	readonly #taken = new Set<string>();

	base(message: PackMessage): string {
		const subject = zipSafeName(message.subject === '' ? '(no subject)' : message.subject, 60);
		const folder = `messages/${mailboxFolder(message)}`;
		const first = `${folder}/${stamp(message.receivedAt)} ${subject} [${message.id.slice(0, 8)}]`;
		const name = this.#taken.has(first.toLowerCase())
			? `${folder}/${stamp(message.receivedAt)} ${subject} [${message.id}]`
			: first;
		this.#taken.add(name.toLowerCase());
		return name;
	}
}

/** An attachment's file name inside its message's attachments folder. */
export function attachmentName(index: number, filename: string): string {
	return `${String(index + 1).padStart(2, '0')} ${zipSafeName(filename === '' ? 'attachment' : filename, 80)}`;
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

function csvCell(value: string): string {
	// A leading = + - @ would run as a formula when the CSV is opened in Excel.
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const MANIFEST_COLUMNS = [
	'file',
	'lookstow_id',
	'mailbox',
	'mailbox_kind',
	'folder',
	'received_utc',
	'from',
	'to_cc',
	'subject',
	'internet_message_id',
	'stored_utc',
	'deleted_at_source_utc',
	'stored_file_sha256',
	'file_sha256',
	'check',
	'attachments'
];

/** manifest.csv: one line a message, UTF-8 with a byte-order mark so Excel reads it right. */
export function manifestCsv(rows: readonly ManifestRow[]): string {
	const lines = [MANIFEST_COLUMNS.join(',')];
	for (const row of rows) {
		const m = row.message;
		lines.push(
			[
				row.file ?? '',
				m.id,
				m.mailboxAddress,
				m.mailboxKind,
				m.folderPath,
				m.receivedAt?.toISOString() ?? '',
				m.sender,
				m.recipients,
				m.subject,
				m.internetMessageId ?? '',
				m.storedAt.toISOString(),
				m.deletedAt?.toISOString() ?? '',
				m.sha256,
				row.fileSha256 ?? '',
				row.check,
				String(row.attachments)
			]
				.map(csvCell)
				.join(',')
		);
	}
	return `${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`;
}

/** SHA256SUMS.txt in the form `sha256sum -c` checks: `<hash>  <path>`. */
export function sumsText(sums: readonly { path: string; sha256: string }[]): string {
	return sums.map((sum) => `${sum.sha256}  ${sum.path}`).join('\n') + '\n';
}

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function href(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

/** index.html: every message as a row, linking to its file. No scripts, nothing loaded. */
export function indexHtml(pack: EvidencePack, rows: readonly ManifestRow[]): string {
	const body = rows
		.map((row) => {
			const m = row.message;
			const subject = escapeHtml(m.subject === '' ? '(no subject)' : m.subject);
			const link = row.file === null ? subject : `<a href="${href(row.file)}">${subject}</a>`;
			const note =
				row.check === 'matches' || row.check === 'converted'
					? ''
					: ` <strong>${row.check}</strong>`;
			return `<tr><td>${escapeHtml(shown(m.receivedAt))}</td><td>${escapeHtml(m.sender)}</td><td>${escapeHtml(m.recipients)}</td><td>${link}${note}</td><td>${escapeHtml(m.mailboxAddress)} / ${escapeHtml(m.folderPath)}</td><td>${m.deletedAt === null ? '' : 'yes'}</td></tr>`;
		})
		.join('\n');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(pack.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top;font-size:14px}th{background:#f4f4f4}</style>
</head><body>
<h1>${escapeHtml(pack.name)}</h1>
<p>${String(rows.length)} messages, made by Lookstow on ${escapeHtml(shown(new Date(pack.createdAt)))}. Times are local time (${escapeHtml(ZONE)}). Open a message to see it in your mail program. README.txt says how to check the files.</p>
<table><thead><tr><th>Received</th><th>From</th><th>To and Cc</th><th>Subject</th><th>Mailbox / folder</th><th>Deleted at source</th></tr></thead>
<tbody>
${body}
</tbody></table>
</body></html>
`;
}

/** README.txt: what the pack is, how it was made, and how to check it has not changed. */
export function readmeText(
	pack: EvidencePack,
	rows: readonly ManifestRow[],
	version: string
): string {
	const written = rows.filter((row) => row.file !== null).length;
	const problems = rows.filter((row) => row.check === 'MISMATCH' || row.check === 'MISSING');
	const lines = [
		pack.name,
		'='.repeat(Math.min(pack.name.length, 80)),
		'',
		`Made by Lookstow ${version}, a backup of Microsoft 365 mailboxes, on ${shown(new Date(pack.createdAt))} (local time, ${ZONE}).`,
		`Asked for by: ${pack.createdBy}.`,
		`Messages: ${String(written)} included${pack.missing.length > 0 ? `; ${String(pack.missing.length)} asked for but not in the backup (listed below)` : ''}.`,
		'',
		'What is here',
		'------------',
		'messages/      One .eml file a message, by mailbox, named by local date and time, subject and the start of',
		'               its Lookstow id. An .eml file opens in Outlook, Thunderbird or Apple Mail.',
		...(pack.withAttachments
			? [
					'attachments/   Each message’s attachments as separate files, in a folder named like its .eml.'
				]
			: []),
		'manifest.csv   One line a message: where it was filed, its dates, senders and recipients,',
		'               and its SHA-256 (see below). Opens in Excel.',
		'index.html     The same list as a page, linking to each message.',
		'SHA256SUMS.txt The SHA-256 of every file in this pack.',
		'',
		'How the messages were kept',
		'--------------------------',
		'Lookstow copies each message from Microsoft 365 as it is and records the SHA-256 of the file',
		'when it stores it. Files are never changed afterwards. When this pack was made, each file was',
		'checked against that SHA-256 (the check column of manifest.csv):',
		'  matches    the file is exactly as stored; file_sha256 equals stored_file_sha256.',
		'  converted  an online archive item: Lookstow stores Microsoft’s export of it, which was',
		'             checked against its SHA-256 and then written out as .eml for this pack.',
		'  MISMATCH   the stored file no longer matches what was recorded; it is included as found.',
		'  MISSING    the stored file could not be read; nothing is included for it.',
		'deleted_at_source_utc: when the message was deleted in Microsoft 365, if it was. Lookstow',
		'keeps deleted messages.',
		'',
		'Checking that nothing has changed',
		'---------------------------------',
		'The SHA-256 of the whole ZIP file was shown in Lookstow when the pack was made, and kept in',
		'Lookstow’s activity log. To check the ZIP file:',
		'  Windows (PowerShell): Get-FileHash <file>.zip -Algorithm SHA256',
		'  macOS or Linux:       shasum -a 256 <file>.zip',
		'To check every file after unzipping, from inside the pack’s folder:',
		'  macOS or Linux:       shasum -a 256 -c SHA256SUMS.txt',
		'  Windows:              compare Get-FileHash <file> with its line in SHA256SUMS.txt',
		''
	];
	if (problems.length > 0) {
		lines.push('Files that did not check out', '----------------------------');
		for (const row of problems)
			lines.push(`${row.check}: ${row.message.id} ${row.message.subject}`);
		lines.push('');
	}
	if (pack.missing.length > 0) {
		lines.push(
			'Asked for but not in the backup',
			'-------------------------------',
			...pack.missing,
			''
		);
	}
	return lines.join('\r\n');
}
