import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../database/connection.ts';
import { activity } from '../../database/schema.ts';
import { deleteMailboxBackup } from '../mailboxes/delete-backup.ts';
import { applyDiscovery, insertMessage, syncFolderList } from '../mailboxes/repository.ts';
import {
	effectiveBackupRoot,
	readBackupMove,
	saveBackup,
	saveBackupMarker,
	saveBackupMove
} from '../settings/settings.ts';
import { writeMarker } from '../storage/backup-marker.ts';
import { backupFolderProblem } from './backup-folder-check.ts';
import { BackupMover } from './backup-move-task.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const folders: string[] = [];

function folder(): string {
	const path = mkdtempSync(join(tmpdir(), 'lookstow-mover-'));
	folders.push(path);
	return path;
}

afterEach(() => {
	for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A database and backup folder holding one stored message, and a mover for them. */
function setup() {
	const db = openDatabase(':memory:');
	const from = folder();
	saveBackup(db, { root: from });
	saveBackupMarker(db, { id: ID });
	writeMarker(from, ID);
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
	const path = 'ann@example.com/2026/11/m1.eml';
	mkdirSync(join(from, 'ann@example.com/2026/11'), { recursive: true });
	writeFileSync(join(from, path), 'the message');
	insertMessage(db, {
		mailboxId: mailbox.id,
		folderId: inbox.id,
		graphId: 'm1',
		internetMessageId: null,
		subject: 's',
		sender: 'b',
		receivedAt: null,
		filePath: path,
		byteCount: 11,
		sha256: createHash('sha256').update('the message').digest('hex'),
		storedAt: new Date(1)
	});
	let stopping = false;
	let changes = 0;
	const mover = new BackupMover({
		db,
		dataDir: folder(),
		now: () => 1000,
		whenIdle: () => Promise.resolve(),
		stopping: () => stopping,
		changed: () => {
			changes += 1;
		}
	});
	return {
		db,
		from,
		path,
		mailbox,
		mover,
		stop: () => (stopping = true),
		changes: () => changes
	};
}

describe('moving the backup folder', () => {
	it('copies, checks and switches to the new folder, keeping the old copy', async () => {
		const { db, from, path, mover } = setup();
		const to = folder();
		await mover.start(to, 'console');
		expect(mover.lockdown()).toContain('moving');
		await mover.stopped();
		expect(effectiveBackupRoot(db, 'unused')).toBe(to);
		expect(readBackupMove(db)).toMatchObject({ kind: 'moved', from, to, files: 2, problems: 0 });
		expect(mover.lockdown()).toBeNull();
		expect(readFileSync(join(to, path), 'utf8')).toBe('the message');
		expect(existsSync(join(from, path))).toBe(true);
		// The new folder carries the same marker, so backups carry on there.
		expect(backupFolderProblem(db, to)).toBeNull();
	});

	it('a move the service did not finish carries on after a restart', async () => {
		const { db, from, mover } = setup();
		const to = folder();
		saveBackupMove(db, { kind: 'moving', from, to, startedAt: '', actor: 'console' });
		mover.resume();
		await mover.stopped();
		expect(readBackupMove(db).kind).toBe('moved');
		expect(effectiveBackupRoot(db, 'unused')).toBe(to);
	});

	it('stopping the service leaves the move to carry on later, without switching', async () => {
		const { db, from, mover, stop } = setup();
		const to = folder();
		stop();
		await mover.start(to, 'console');
		await mover.stopped();
		expect(readBackupMove(db).kind).toBe('moving');
		expect(effectiveBackupRoot(db, 'unused')).toBe(from);
	});

	it('Stop the move keeps the backup where it was', () => {
		const { db, from, mover } = setup();
		const to = folder();
		saveBackupMove(db, { kind: 'moving', from, to, startedAt: '', actor: 'console' });
		mover.cancel('console');
		expect(readBackupMove(db)).toEqual({ kind: 'none' });
		expect(effectiveBackupRoot(db, 'unused')).toBe(from);
	});

	it('refuses a folder that is not prepared, and a second move', async () => {
		const { mover } = setup();
		await expect(mover.start(join(folder(), 'missing'), 'console')).rejects.toThrow(
			'backup-folder prepare'
		);
		await mover.start(folder(), 'console');
		await mover.stopped();
		await expect(mover.start(folder(), 'console')).rejects.toThrow('old copy');
	});

	it('no backup can be deleted while the move runs', async () => {
		const { db, from, mailbox, mover } = setup();
		saveBackupMove(db, { kind: 'moving', from, to: folder(), startedAt: '', actor: 'console' });
		expect(mover.lockdown()).not.toBeNull();
		await expect(deleteMailboxBackup(db, mailbox, from, 'console')).rejects.toThrow('moving');
	});

	it('removes the old copy only after a move, and records it', async () => {
		const { db, from, mover, changes } = setup();
		expect(() => {
			mover.removeOld('console');
		}).toThrow('no old copy');
		await mover.start(folder(), 'console');
		await mover.stopped();
		mover.removeOld('console');
		await mover.stopped();
		expect(existsSync(from)).toBe(false);
		expect(readBackupMove(db)).toEqual({ kind: 'none' });
		expect(changes()).toBeGreaterThan(0);
		const summaries = db
			.select()
			.from(activity)
			.where(eq(activity.kind, 'backup-move'))
			.all()
			.map((entry) => entry.summary);
		expect(summaries.at(-1)).toContain('was removed (2 files)');
	});
});
