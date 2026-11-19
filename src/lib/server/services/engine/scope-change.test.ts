import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Queryable } from '../../database/connection.ts';
import { SCOPE_DEFAULTS, type ScopeSettings } from '../../../domain/settings.ts';
import {
	allMailboxes,
	applyDiscovery,
	insertMessage,
	mailboxById,
	syncFolderList,
	type MailboxRow
} from '../mailboxes/repository.ts';
import { readScope, saveScope } from '../settings/settings.ts';
import {
	backupsOutsideScope,
	changeScope,
	describeScopeChange,
	type ScopeEngine
} from './scope-change.ts';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'lookstow-scope-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** An engine with nothing running, except the mailboxes listed as busy. */
function fakeEngine(busy: readonly string[] = []): ScopeEngine & { synced: string[] } {
	const synced: string[] = [];
	return {
		synced,
		cancel: () => undefined,
		waitUntilIdle: (id: string) => Promise.resolve(!busy.includes(id)),
		requestSync: (ids: string[] | null) => {
			synced.push(...(ids ?? []));
		}
	};
}

function user(address: string, userId: string) {
	return { userId, kind: 'user', address, displayName: address, exchangeMailboxId: null };
}

/** Stores one message for the mailbox, on disk and in the index. */
async function storeMessage(db: Queryable, mailbox: MailboxRow, bytes: number): Promise<void> {
	const [folder] = syncFolderList(
		db,
		mailbox.id,
		[{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' }],
		1
	);
	if (folder === undefined) throw new Error('no folder');
	const file = `${mailbox.address}/2026/11/${String(bytes)}.eml`;
	await mkdir(join(root, mailbox.address, '2026', '11'), { recursive: true });
	await writeFile(join(root, file), 'x'.repeat(bytes));
	insertMessage(db, {
		mailboxId: mailbox.id,
		folderId: folder.id,
		graphId: `m${String(bytes)}`,
		internetMessageId: null,
		subject: 's',
		sender: 'b',
		receivedAt: null,
		filePath: file,
		byteCount: bytes,
		sha256: 'x',
		storedAt: new Date(1)
	});
}

/** Three backed-up user mailboxes, then the scope narrowed to Ann alone with Keep. */
async function narrowedWithKeep() {
	const db = openDatabase(':memory:');
	const { added } = applyDiscovery(
		db,
		[user('ann@example.com', 'u1'), user('bob@example.com', 'u2'), user('cat@example.com', 'u3')],
		1
	);
	for (const [index, mailbox] of added.entries()) {
		await storeMessage(db, mailbox, 10 + index);
	}
	const annOnly: ScopeSettings = {
		...SCOPE_DEFAULTS,
		mode: 'selected',
		selectedAddresses: ['ann@example.com']
	};
	const kept = await changeScope(db, fakeEngine(), root, annOnly, { kind: 'keep' });
	return { db, annOnly, kept };
}

describe('changing what is backed up', () => {
	it('keeps the backups of mailboxes it leaves out, and says how many', async () => {
		const { db, kept } = await narrowedWithKeep();
		expect(kept).toMatchObject({ kind: 'saved', leaving: 2, kept: { mailboxes: 2, bytes: 23 } });
		expect(existsSync(join(root, 'bob@example.com'))).toBe(true);
		expect(backupsOutsideScope(db)).toEqual({ mailboxes: 2, bytes: 23 });
	});

	it('deletes backups left out by an earlier change when Delete is chosen with nothing leaving', async () => {
		const { db, annOnly } = await narrowedWithKeep();
		const change = await changeScope(db, fakeEngine(), root, annOnly, {
			kind: 'delete',
			confirmation: 'DELETE'
		});
		expect(change).toMatchObject({ kind: 'saved', leaving: 0, deleted: { mailboxes: 2 } });
		expect(existsSync(join(root, 'bob@example.com'))).toBe(false);
		expect(existsSync(join(root, 'cat@example.com'))).toBe(false);
		expect(existsSync(join(root, 'ann@example.com'))).toBe(true);
		expect(backupsOutsideScope(db)).toEqual({ mailboxes: 0, bytes: 0 });
	});

	it('refuses Delete without the typed confirmation and changes nothing', async () => {
		const { db, annOnly } = await narrowedWithKeep();
		const everyone = { ...annOnly, mode: 'all' as const };
		const change = await changeScope(db, fakeEngine(), root, everyone, {
			kind: 'delete',
			confirmation: 'delete please'
		});
		expect(change.kind).toBe('refused');
		expect(readScope(db).mode).toBe('selected');
		expect(existsSync(join(root, 'bob@example.com'))).toBe(true);
	});

	it('says plainly when Delete had nothing to delete', async () => {
		const db = openDatabase(':memory:');
		saveScope(db, SCOPE_DEFAULTS);
		const change = await changeScope(db, fakeEngine(), root, SCOPE_DEFAULTS, {
			kind: 'delete',
			confirmation: 'DELETE'
		});
		if (change.kind !== 'saved') throw new Error(change.reason);
		expect(describeScopeChange(change)).toContain('nothing was deleted');
	});

	it('keeps a backup whose sync does not stop in time, and names it', async () => {
		const { db, annOnly } = await narrowedWithKeep();
		const bob = mailboxByAddress(db, 'bob@example.com');
		const change = await changeScope(db, fakeEngine([bob.id]), root, annOnly, {
			kind: 'delete',
			confirmation: 'DELETE'
		});
		if (change.kind !== 'saved') throw new Error(change.reason);
		expect(change.stillSyncing).toEqual(['bob@example.com']);
		expect(existsSync(join(root, 'bob@example.com'))).toBe(true);
		expect(existsSync(join(root, 'cat@example.com'))).toBe(false);
		expect(describeScopeChange(change)).toContain('save again in a minute');
	});

	it('counts a mailbox whose first copy was cut off as having a backup', async () => {
		const db = openDatabase(':memory:');
		const { added } = applyDiscovery(db, [user('dan@example.com', 'u4')], 1);
		const dan = added[0];
		if (dan === undefined) throw new Error('no mailbox');
		// A sync that stops part-way never finishes, so only the stored messages say it has a backup.
		await storeMessage(db, dan, 7);
		expect(mailboxById(db, dan.id)).toMatchObject({ itemCount: 1, byteCount: 7 });
		const change = await changeScope(
			db,
			fakeEngine(),
			root,
			{ ...SCOPE_DEFAULTS, mode: 'selected', selectedAddresses: [] },
			{ kind: 'delete', confirmation: 'DELETE' }
		);
		expect(change).toMatchObject({ kind: 'saved', deleted: { mailboxes: 1, bytes: 7 } });
	});
});

function mailboxByAddress(db: Queryable, address: string): MailboxRow {
	const found = allMailboxes(db).find((row) => row.address === address);
	if (found === undefined) throw new Error(`no ${address}`);
	return found;
}
