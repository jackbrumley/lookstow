import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { applyDiscovery, insertMessage, syncFolderList } from '../mailboxes/repository.ts';
import { PackBuilder } from './builder.ts';
import { createPack, listPacks, packZipPath, planPack, readPack, removePack } from './packs.ts';
import { readZip } from '#tests/support/read-zip.ts';
// Packs are made in the background and polled; the full suite runs many files at once.
vi.setConfig({ testTimeout: 20_000 });

const folders: string[] = [];
afterEach(async () => {
	for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

function sha(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

function eml(subject: string, withPicture = false): string {
	if (!withPicture) {
		return `From: ann@example.com\r\nTo: pay@example.com\r\nSubject: ${subject}\r\n\r\nHours: 38\r\n`;
	}
	return [
		'From: ann@example.com',
		`Subject: ${subject}`,
		'Content-Type: multipart/mixed; boundary="m"',
		'',
		'--m',
		'Content-Type: text/plain',
		'',
		'See attached',
		'--m',
		'Content-Type: image/png; name="sheet.png"',
		'Content-Transfer-Encoding: base64',
		'Content-Disposition: attachment; filename="sheet.png"',
		'',
		Buffer.from('not really a png').toString('base64'),
		'--m--',
		''
	].join('\r\n');
}

async function setup() {
	const dataDir = await mkdtemp(join(tmpdir(), 'lookstow-pack-'));
	folders.push(dataDir);
	const backupRoot = join(dataDir, 'mailboxes');
	const db = openDatabase(':memory:');
	const mailbox = applyDiscovery(
		db,
		[
			{
				userId: 'u1',
				kind: 'user',
				address: 'ann@example.com',
				displayName: 'Ann',
				exchangeMailboxId: null
			}
		],
		1
	).added[0];
	if (mailbox === undefined) throw new Error('no mailbox');
	const [inbox] = syncFolderList(
		db,
		mailbox.id,
		[{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' }],
		1
	);
	if (inbox === undefined) throw new Error('no folder');
	const store = async (
		graphId: string,
		subject: string,
		content: string,
		recorded: string,
		write = true
	) => {
		const filePath = `ann@example.com/2024/03/${graphId}.eml`;
		if (write) {
			await mkdir(join(backupRoot, 'ann@example.com/2024/03'), { recursive: true });
			await writeFile(join(backupRoot, filePath), content);
		}
		return insertMessage(db, {
			mailboxId: mailbox.id,
			folderId: inbox.id,
			graphId,
			internetMessageId: `<${graphId}@example.com>`,
			subject,
			sender: 'ann@example.com',
			receivedAt: new Date('2024-03-05T09:12:00Z'),
			filePath,
			byteCount: content.length,
			sha256: recorded,
			storedAt: new Date('2024-03-05T09:20:00Z')
		});
	};
	const good = eml('=Timesheet, week 12', true);
	const changed = eml('Changed later');
	const ids = {
		good: await store('m1', '=Timesheet, week 12', good, sha(good)),
		changed: await store('m2', 'Changed later', changed, sha('something else')),
		gone: await store('m3', 'File gone', 'x', sha('x'), false)
	};
	const builder = new PackBuilder({ db, dataDir, backupRoot: () => backupRoot });
	return { db, dataDir, ids, good, builder };
}

async function finished(dataDir: string, id: string) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const pack = await readPack(dataDir, id);
		if (pack?.status === 'ready' || pack?.status === 'failed') return pack;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('The pack did not finish');
}

describe('making an evidence pack', () => {
	it('puts each message in as stored, checks it, and lists what is missing or changed', async () => {
		const { db, dataDir, ids, good, builder } = await setup();
		const unknown = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
		const plan = await planPack(db, dataDir, [ids.good, ids.changed, ids.gone, unknown], 1, true);
		expect(plan).toMatchObject({ missing: [unknown], repeats: 1, refusal: null });
		expect(plan.found).toEqual([ids.good, ids.changed, ids.gone]);
		const queued = await createPack(dataDir, plan, {
			name: 'Timesheets: for counsel',
			createdBy: 'console',
			withAttachments: true
		});
		await builder.enqueue(queued.id);
		const pack = await finished(dataDir, queued.id);
		expect(pack).toMatchObject({
			status: 'ready',
			total: 3,
			done: 3,
			mismatched: 1,
			unreadable: 1,
			missing: [unknown]
		});
		const zip = await readFile(packZipPath(dataDir, pack.id));
		expect(pack.sha256).toBe(sha(zip));
		expect(pack.zipBytes).toBe(zip.length);
		const files = new Map(readZip(zip).files.map((file) => [file.name, file.data]));
		const top = 'Timesheets for counsel';
		const goodName = `${top}/messages/ann@example.com/2024-03-05 0912 =Timesheet, week 12 [${ids.good.slice(0, 8)}].eml`;
		expect(files.get(goodName)?.toString()).toBe(good);
		expect(
			files
				.get(
					`${top}/attachments/ann@example.com/2024-03-05 0912 =Timesheet, week 12 [${ids.good.slice(0, 8)}]/01 sheet.png`
				)
				?.toString()
		).toBe('not really a png');
		const manifest = files.get(`${top}/manifest.csv`)?.toString() ?? '';
		expect(manifest.charCodeAt(0)).toBe(0xfeff);
		// A subject starting with = is kept from running as a formula in Excel.
		expect(manifest).toContain(`"'=Timesheet, week 12"`);
		expect(manifest).toMatch(/,matches,1\r\n/);
		expect(manifest).toMatch(/,MISMATCH,0\r\n/);
		expect(manifest).toMatch(/,MISSING,0\r\n/);
		const readme = files.get(`${top}/README.txt`)?.toString() ?? '';
		expect(readme).toContain(unknown);
		expect(readme).toContain(`MISMATCH: ${ids.changed}`);
		expect(readme).toContain(`MISSING: ${ids.gone}`);
		const sums = files.get(`${top}/SHA256SUMS.txt`)?.toString() ?? '';
		for (const [name, data] of files) {
			if (name.endsWith('SHA256SUMS.txt')) continue;
			expect(sums).toContain(`${sha(data)}  ${name.slice(top.length + 1)}`);
		}
		const index = files.get(`${top}/index.html`)?.toString() ?? '';
		expect(index).not.toContain('<script');
		expect(index).toContain("default-src 'none'");
		const activity = db.$client
			.prepare("select summary from activity where kind = 'evidence-pack'")
			.all();
		expect(activity).toEqual([{ summary: 'Evidence pack ready: Timesheets for counsel' }]);
	});

	it('refuses when none of the ids are in the backup, or there are none', async () => {
		const { db, dataDir } = await setup();
		expect(
			(await planPack(db, dataDir, ['0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'], 0, false)).refusal
		).toMatch(/None of these/);
		expect((await planPack(db, dataDir, [], 0, false)).refusal).toMatch(/No message ids/);
	});

	it('stops and removes a pack asked to stop, and removes a finished one at once', async () => {
		const { db, dataDir, ids, builder } = await setup();
		const plan = await planPack(db, dataDir, [ids.good], 0, false);
		const queued = await createPack(dataDir, plan, {
			name: 'Stop me',
			createdBy: 'console',
			withAttachments: false
		});
		await removePack(dataDir, queued);
		await builder.enqueue(queued.id);
		for (
			let attempt = 0;
			attempt < 100 && (await readPack(dataDir, queued.id)) !== null;
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect((await listPacks(dataDir)).packs).toEqual([]);

		const again = await createPack(dataDir, plan, {
			name: 'Keep briefly',
			createdBy: 'console',
			withAttachments: false
		});
		await builder.enqueue(again.id);
		const ready = await finished(dataDir, again.id);
		expect(ready.status).toBe('ready');
		await removePack(dataDir, ready);
		expect((await listPacks(dataDir)).packs).toEqual([]);
	});
});
