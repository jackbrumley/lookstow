import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openDatabase } from '../../database/connection.ts';
import { applyDiscovery, insertMessage, syncFolderList } from '../mailboxes/repository.ts';
import { resolveStoragePath, writeMessageFile } from '../storage/eml-store.ts';
import { authoriseAi, newAiToken, setAiEnabled } from './access.ts';
import { indexContent } from './content-index.ts';
import { AUDIT_FOLDER, handleMcp } from './mcp.ts';
import { parseEml } from './mime.ts';
import { PackBuilder } from '../evidence/builder.ts';
// Packs are made in the background and polled; the full suite runs many files at once.
vi.setConfig({ testTimeout: 20_000 });

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);

/** An invented timesheet email: text, a forwarded-style HTML part, a photo and a PDF. */
const EML = Buffer.from(
	[
		'From: Farm Manager <manager@example.com>',
		'To: payroll@example.com',
		'Subject: =?UTF-8?B?VGltZXNoZWV0IOKAkyB3ZWVrIDE=?=',
		'Date: Mon, 2 Mar 2020 08:00:00 +1000',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="outer"',
		'',
		'--outer',
		'Content-Type: multipart/alternative; boundary="inner"',
		'',
		'--inner',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		'Hi, timesheet attached for =E2=80=9CNorth=E2=80=9D farm.',
		'--inner',
		'Content-Type: text/html; charset=utf-8',
		'',
		'<p>Hi, timesheet attached</p>',
		'--inner--',
		'--outer',
		'Content-Type: image/png; name="sheet.png"',
		'Content-Disposition: attachment; filename="sheet.png"',
		'Content-Transfer-Encoding: base64',
		'',
		PNG.toString('base64'),
		'--outer',
		'Content-Type: application/pdf',
		"Content-Disposition: attachment; filename*=UTF-8''week%201.pdf",
		'Content-Transfer-Encoding: base64',
		'',
		Buffer.from('%PDF-1.4 invented').toString('base64'),
		'--outer--',
		''
	].join('\r\n')
);

describe('reading a stored message', () => {
	it('finds the text, the headers and every attachment', () => {
		const parsed = parseEml(EML);
		expect(parsed.headers.get('subject')).toBe('Timesheet – week 1');
		expect(parsed.text).toBe('Hi, timesheet attached for “North” farm.');
		expect(parsed.attachments.map((attachment) => attachment.filename)).toEqual([
			'sheet.png',
			'week 1.pdf'
		]);
		expect(parsed.attachments[0]?.data).toEqual(PNG);
		expect(parsed.attachments[1]?.contentType).toBe('application/pdf');
	});

	it('drops invisible padding and the external-sender banner, and opens forwarded emails', () => {
		const zwj = String.fromCharCode(0x200d);
		const forwarded = Buffer.concat([
			Buffer.from(
				[
					'From: Jason <jason@example.com>',
					'Subject: Fwd: hours',
					'Content-Type: multipart/mixed; boundary="f"',
					'',
					'--f',
					'Content-Type: text/plain; charset=utf-8',
					'',
					`See attached${` ${zwj}`.repeat(200)}`,
					'ZjQcmQRYFpfptBannerStart',
					'This Message Is From an External Sender',
					'ZjQcmQRYFpfptBannerEnd',
					'--f',
					'Content-Type: message/rfc822',
					'',
					''
				].join('\r\n'),
				'utf8'
			),
			EML,
			Buffer.from('\r\n--f--\r\n')
		]);
		const parsed = parseEml(forwarded);
		expect(parsed.text).toMatch(/^See attached\n\n--- Attached email: Timesheet – week 1/);
		expect(parsed.text).toContain('“North” farm');
		expect(parsed.text).not.toContain('External Sender');
		expect(
			parsed.attachments.map((attachment) => [attachment.filename, attachment.insideAttachment])
		).toEqual([
			['Timesheet – week 1.eml', null],
			['sheet.png', 0],
			['week 1.pdf', 0]
		]);
	});
});

const replySchema = z.object({
	result: z
		.looseObject({
			content: z
				.array(
					z.object({
						type: z.string(),
						text: z.string().optional(),
						data: z.string().optional(),
						mimeType: z.string().optional()
					})
				)
				.optional(),
			isError: z.boolean().optional(),
			tools: z.array(z.object({ name: z.string() })).optional()
		})
		.optional(),
	error: z.object({ message: z.string() }).optional()
});

async function setup() {
	const db = openDatabase(':memory:');
	const { added } = applyDiscovery(
		db,
		[
			{
				userId: 'u',
				kind: 'user',
				address: 'payroll@example.com',
				displayName: 'Payroll',
				exchangeMailboxId: null
			}
		],
		1
	);
	const mailbox = added[0];
	if (mailbox === undefined) throw new Error('no mailbox');
	const [folder] = syncFolderList(
		db,
		mailbox.id,
		[{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' }],
		1
	);
	if (folder === undefined) throw new Error('no folder');
	const backupRoot = await mkdtemp(join(tmpdir(), 'lookstow-ai-'));
	const dataDir = await mkdtemp(join(tmpdir(), 'lookstow-ai-data-'));
	const relative = 'payroll@example.com/2020/03/message.eml';
	const stored = await writeMessageFile(resolveStoragePath(backupRoot, relative), EML);
	insertMessage(db, {
		mailboxId: mailbox.id,
		folderId: folder.id,
		graphId: 'g1',
		internetMessageId: null,
		subject: 'Timesheet – week 1',
		sender: 'manager@example.com',
		recipients: 'payroll@example.com',
		receivedAt: new Date(Date.parse('2020-03-01T22:00:00Z')),
		filePath: relative,
		byteCount: stored.byteCount,
		sha256: stored.sha256,
		storedAt: new Date(2)
	});
	const context = {
		db,
		backupRoot,
		baseUrl: 'http://127.0.0.1:8030',
		dataDir,
		now: () => Date.parse('2026-11-19T00:00:00Z'),
		evidence: {
			builder: new PackBuilder({ db, dataDir, backupRoot: () => backupRoot }),
			dataDir
		}
	};
	let id = 0;
	const call = async (method: string, params: unknown = {}) => {
		id += 1;
		const reply = await handleMcp(context, { jsonrpc: '2.0', id, method, params });
		return replySchema.parse(reply.body);
	};
	return { db, call, mailbox, dataDir, backupRoot };
}

function json(reply: z.infer<typeof replySchema>): unknown {
	return JSON.parse(reply.result?.content?.[0]?.text ?? 'null');
}

function parsed<T>(value: unknown, schema: z.ZodType<T>): T {
	return schema.parse(value);
}

describe('the AI tools over MCP', () => {
	it('is refused until turned on, and then only with the current token', async () => {
		const { db } = await setup();
		expect(authoriseAi(db, 'Bearer x')).toMatchObject({ ok: false, status: 403 });
		setAiEnabled(db, true);
		const token = newAiToken(db);
		expect(authoriseAi(db, null)).toMatchObject({ ok: false, status: 401 });
		expect(authoriseAi(db, 'Bearer wrong')).toMatchObject({ ok: false, status: 401 });
		expect(authoriseAi(db, `Bearer ${token}`)).toEqual({ ok: true });
		newAiToken(db);
		expect(authoriseAi(db, `Bearer ${token}`)).toMatchObject({ ok: false });
	});

	it('lists, searches, opens a message and shows its photo, and audits each call', async () => {
		const { call, mailbox, dataDir } = await setup();
		const init = await call('initialize', { protocolVersion: '2025-06-18' });
		expect(init.result).toMatchObject({
			protocolVersion: '2025-06-18',
			capabilities: { tools: {} }
		});
		const tools = (await call('tools/list')).result?.tools ?? [];
		expect(tools.map((tool) => tool.name)).toEqual([
			'list_mailboxes',
			'search_messages',
			'top_senders',
			'get_message',
			'get_attachment',
			'create_evidence_pack',
			'list_evidence_packs',
			'get_evidence_pack'
		]);
		expect(json(await call('tools/call', { name: 'list_mailboxes' }))).toEqual([
			expect.objectContaining({ id: mailbox.id, storedMessages: 1 })
		]);
		const found = parsed(
			json(
				await call('tools/call', {
					name: 'search_messages',
					arguments: { from: 'manager', after: '2020-03-01', withContent: true }
				})
			),
			z.object({
				total: z.number(),
				messages: z.array(
					z.object({ id: z.string(), attachments: z.array(z.unknown()), textStart: z.string() })
				)
			})
		);
		expect(found.total).toBe(1);
		const hit = found.messages[0];
		expect(hit?.attachments).toHaveLength(2);
		expect(hit?.textStart).toContain('North');
		const message = parsed(
			json(await call('tools/call', { name: 'get_message', arguments: { messageId: hit?.id } })),
			z.object({ attachments: z.array(z.object({ sha256: z.string(), url: z.string() })) })
		);
		expect(message.attachments[0]?.url).toBe(
			`http://127.0.0.1:8030/mcp/attachments/${hit?.id ?? ''}/0`
		);
		const photo = await call('tools/call', {
			name: 'get_attachment',
			arguments: { messageId: hit?.id, index: 0 }
		});
		expect(photo.result?.content?.[1]).toEqual({
			type: 'image',
			data: PNG.toString('base64'),
			mimeType: 'image/png'
		});
		const pdf = parsed(
			json(
				await call('tools/call', {
					name: 'get_attachment',
					arguments: { messageId: hit?.id, index: 1 }
				})
			),
			z.object({ howToOpen: z.string() })
		);
		expect(pdf.howToOpen).toContain('curl');
		const missing = await call('tools/call', {
			name: 'get_message',
			arguments: { messageId: 'nope' }
		});
		expect(missing.result?.isError).toBe(true);
		const [file] = await readdir(join(dataDir, AUDIT_FOLDER));
		const lines = (await readFile(join(dataDir, AUDIT_FOLDER, file ?? ''), 'utf8'))
			.trim()
			.split('\n');
		expect(lines).toHaveLength(6);
		expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ tool: 'list_mailboxes', ok: true });
	});

	it('indexes message content, then filters by body words and attachments, and counts senders', async () => {
		const { db, call, backupRoot } = await setup();
		expect(
			await indexContent(
				db,
				() => backupRoot,
				() => false
			)
		).toBe(1);
		const searchFor = async (args: Record<string, unknown>) =>
			parsed(
				json(await call('tools/call', { name: 'search_messages', arguments: args })),
				z.object({
					total: z.number(),
					contentIndex: z.object({ indexed: z.number(), total: z.number() }),
					messages: z.array(z.object({ id: z.string() }))
				})
			);
		const found = await searchFor({ body: 'north farm', hasPdf: true });
		expect(found.total).toBe(1);
		expect(found.contentIndex).toEqual({ indexed: 1, total: 1 });
		// The 70-byte PNG is too small to be a photo (a logo, say).
		expect((await searchFor({ hasPhotos: true })).total).toBe(0);
		expect((await searchFor({ body: 'south' })).total).toBe(0);
		const senders = parsed(
			json(await call('tools/call', { name: 'top_senders', arguments: { hasAttachments: true } })),
			z.array(z.object({ sender: z.string(), messages: z.number() }))
		);
		expect(senders).toEqual([{ sender: 'manager@example.com', messages: 1 }]);
	});

	it('makes an evidence pack, follows it, and gives its download URL', async () => {
		const { call, db } = await setup();
		const [row] = db.$client.prepare('select id from messages').all();
		const messageId = parsed(row, z.object({ id: z.string() })).id;
		const unknown = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
		const created = parsed(
			json(
				await call('tools/call', {
					name: 'create_evidence_pack',
					arguments: { name: 'For counsel', messageIds: [messageId, unknown, messageId] }
				})
			),
			z.object({ id: z.string(), messages: z.number(), missing: z.array(z.string()) })
		);
		expect(created).toMatchObject({ messages: 1, missing: [unknown] });
		const packSchema = z.object({
			state: z.string(),
			sha256: z.string().nullable(),
			downloadUrl: z.string().nullable()
		});
		let pack = packSchema.parse({ state: 'queued', sha256: null, downloadUrl: null });
		for (let attempt = 0; attempt < 200 && pack.state !== 'ready'; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			pack = parsed(
				json(
					await call('tools/call', { name: 'get_evidence_pack', arguments: { packId: created.id } })
				),
				packSchema
			);
		}
		expect(pack.state).toBe('ready');
		expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(pack.downloadUrl).toBe(
			`http://127.0.0.1:8030/mcp/evidence-packs/${created.id}/download`
		);
		const listed = parsed(
			json(await call('tools/call', { name: 'list_evidence_packs' })),
			z.array(z.object({ id: z.string(), state: z.string() }))
		);
		expect(listed).toEqual([expect.objectContaining({ id: created.id, state: 'ready' })]);
		const refused = await call('tools/call', {
			name: 'create_evidence_pack',
			arguments: { messageIds: [unknown] }
		});
		expect(refused.result?.isError).toBe(true);
	});

	it('answers notifications with nothing and unknown methods with an error', async () => {
		const { db, dataDir } = await setup();
		const context = { db, backupRoot: '', baseUrl: '', dataDir, now: Date.now };
		expect(
			await handleMcp(context, { jsonrpc: '2.0', method: 'notifications/initialized' })
		).toEqual({
			status: 202,
			body: null
		});
		expect(
			(await handleMcp(context, { jsonrpc: '2.0', id: 1, method: 'resources/list' })).body
		).toMatchObject({ error: { code: -32601 } });
	});
});
