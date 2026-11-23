import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	FakeGraph,
	TEST_CREDENTIALS,
	graphError,
	json,
	noSleep
} from '#tests/support/fake-graph.ts';
import { openDatabase } from '../../database/connection.ts';
import { GraphClient } from '../graph/client.ts';
import { unpacedGovernor } from '../graph/governor.ts';
import { TokenSource } from '../graph/token.ts';
import { mailboxItemFailures } from '../mailboxes/item-failures.ts';
import {
	applyDiscovery,
	foldersOf,
	mailboxById,
	saveFolderProgress,
	syncFolderList
} from '../mailboxes/repository.ts';
import { mailFolders, messageEvents, messages } from '../../database/schema.ts';
import { eq } from 'drizzle-orm';
import { syncMailbox } from './mailbox-sync.ts';
import { withUniqueStoragePaths, type SyncContext } from './sync-common.ts';

const USER = 'u1';
const INBOX = `/v1.0/users/${USER}/mailFolders`;

function message(id: string, subject: string) {
	return {
		id,
		internetMessageId: `<${id}@example.com>`,
		subject,
		from: { emailAddress: { address: 'bob@example.com' } },
		receivedDateTime: '2026-03-04T05:06:07Z'
	};
}

/** A mailbox with Inbox (and a child folder) whose delta pages are given per test. */
function mailbox(deltas: Record<string, () => Response>): FakeGraph {
	const graph = new FakeGraph()
		.withToken()
		.on(new RegExp(`^${INBOX}\\?`), () =>
			json({
				value: [
					{ id: 'inbox', displayName: 'Inbox', childFolderCount: 1, totalItemCount: 3 },
					{ id: 'sent', displayName: 'Sent Items', childFolderCount: 0, totalItemCount: 0 }
				]
			})
		)
		.on(new RegExp(`^${INBOX}/inbox/childFolders`), () =>
			json({ value: [{ id: 'proj', displayName: 'Projects', childFolderCount: 0 }] })
		)
		.on(new RegExp(`/messages/([^/]+)/\\$value$`), (url) => {
			const id = /messages\/([^/]+)\/\$value/.exec(decodeURIComponent(url.pathname))?.[1] ?? '';
			return new Response(`Message-ID: <${id}@example.com>\r\nSubject: test\r\n\r\nbody of ${id}`);
		});
	for (const [key, reply] of Object.entries(deltas)) {
		graph.on(new RegExp(key), reply);
	}
	return graph;
}

async function setup(graph: FakeGraph) {
	const db = openDatabase(':memory:');
	const { added } = applyDiscovery(
		db,
		[
			{
				userId: USER,
				kind: 'user',
				address: 'ann@example.com',
				displayName: 'Ann',
				exchangeMailboxId: null
			}
		],
		1
	);
	const row = added[0];
	if (row === undefined) throw new Error('no mailbox');
	const backupRoot = await mkdtemp(join(tmpdir(), 'lookstow-sync-'));
	let stopping = false;
	const context: SyncContext = {
		db,
		client: new GraphClient(new TokenSource(TEST_CREDENTIALS, graph.fetch), {
			governor: unpacedGovernor(),
			fetch: graph.fetch,
			sleep: noSleep
		}),
		backupRoot,
		now: () => 1000,
		stopping: () => stopping,
		progress: () => undefined
	};
	return { db, row, backupRoot, context, stop: () => (stopping = true) };
}

const empty = () =>
	json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/empty-delta' });

describe('syncing one mailbox', () => {
	it('copies every message as .eml, page by page, and saves the delta link', async () => {
		const graph = mailbox({
			'mailFolders/inbox/messages/delta': () =>
				json({
					value: [message('m1', 'First'), message('m2', 'Second')],
					'@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2'
				}),
			'^/v1\\.0/page2$': () =>
				json({
					value: [message('m3', 'Third')],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-delta-1'
				}),
			'mailFolders/(sent|proj)/messages/delta': empty
		});
		const { db, row, backupRoot, context } = await setup(graph);
		const outcome = await syncMailbox(context, row);
		expect(outcome).toMatchObject({
			added: 3,
			removed: 0,
			firstCopyDone: true,
			stoppedEarly: false
		});
		const stored = db.select().from(messages).all();
		expect(stored).toHaveLength(3);
		const first = stored.find((m) => m.graphId === 'm1');
		expect(first?.filePath).toMatch(
			/^ann@example.com\/2026\/03\/2026-03-04_050607_First_[0-9a-f]{10}\.eml$/
		);
		expect(
			await readFile(join(backupRoot, ...(first?.filePath ?? '').split('/')), 'utf8')
		).toContain('body of m1');
		const inbox = foldersOf(db, row.id).find((f) => f.graphId === 'inbox');
		expect(inbox).toMatchObject({
			deltaLink: 'https://graph.microsoft.com/v1.0/inbox-delta-1',
			firstCopyDone: true,
			path: 'Inbox'
		});
		expect(
			foldersOf(db, row.id)
				.map((f) => f.path)
				.sort()
		).toEqual(['Inbox', 'Inbox/Projects', 'Sent Items']);
	});

	it("records Microsoft's folder count after an up-to-date sync", async () => {
		const graph = mailbox({
			'mailFolders/inbox/messages/delta': () =>
				json({
					value: [message('m1', 'First')],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-delta-1'
				}),
			'mailFolders/(sent|proj)/messages/delta': empty
		});
		const { db, row, context } = await setup(graph);
		await syncMailbox(context, row);
		const counts = Object.fromEntries(
			foldersOf(db, row.id).map((folder) => [folder.path, folder.sourceCount])
		);
		// Microsoft says Inbox holds 3, one is stored: the check shows both. Projects gave no count.
		expect(counts).toEqual({ Inbox: 3, 'Sent Items': 0, 'Inbox/Projects': null });
	});

	it('after a restored index, newer mail is rewritten, not duplicated', async () => {
		const deltas = {
			'mailFolders/inbox/messages/delta': () =>
				json({
					value: [message('m1', 'First'), message('m2', 'Second')],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-delta-1'
				}),
			'mailFolders/(sent|proj)/messages/delta': empty
		};
		const first = await setup(mailbox(deltas));
		await syncMailbox(first.context, first.row);
		const filesBefore = await readdir(first.backupRoot, { recursive: true });
		// An index from before those messages: the files are on disk, the index does not know them.
		const restored = await setup(mailbox(deltas));
		await syncMailbox({ ...restored.context, backupRoot: first.backupRoot }, restored.row);
		expect((await readdir(first.backupRoot, { recursive: true })).sort()).toEqual(
			filesBefore.sort()
		);
		expect(restored.db.select().from(messages).all()).toHaveLength(2);
	});

	it('keeps the files of deleted messages and follows moves without downloading again', async () => {
		let round = 0;
		const graph = mailbox({
			'mailFolders/inbox/messages/delta': () =>
				json({
					value: [message('m1', 'Kept'), message('m2', 'Moved')],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-d'
				}),
			'^/v1\\.0/inbox-d$': () => {
				round += 1;
				return json({
					value: [
						{ id: 'm1', '@removed': { reason: 'deleted' } },
						{ id: 'm2', '@removed': { reason: 'changed' } }
					],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-d'
				});
			},
			'mailFolders/proj/messages/delta': () =>
				json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/proj-d' }),
			'^/v1\\.0/proj-d$': () =>
				json({
					value: round > 0 ? [message('m2', 'Moved')] : [],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/proj-d'
				}),
			'mailFolders/sent/messages/delta': empty,
			'^/v1\\.0/empty-delta$': empty
		});
		const { db, row, context } = await setup(graph);
		await syncMailbox(context, row);
		const downloads = graph.requests.filter((r) => r.endsWith('$value')).length;
		const second = await syncMailbox(context, row);
		expect(second.added).toBe(0);
		expect(graph.requests.filter((r) => r.endsWith('$value')).length).toBe(downloads);
		const byId = new Map(
			db
				.select()
				.from(messages)
				.all()
				.map((m) => [m.graphId, m])
		);
		const projects = foldersOf(db, row.id).find((f) => f.graphId === 'proj');
		expect(byId.get('m1')?.deletedAt).not.toBeNull();
		const history = (graphId: string) =>
			db
				.select()
				.from(messageEvents)
				.where(eq(messageEvents.messageId, byId.get(graphId)?.id ?? ''))
				.orderBy(messageEvents.at)
				.all()
				.map((event) => [event.kind, event.fromFolderPath, event.toFolderPath]);
		expect(history('m1')).toEqual([
			['stored', null, 'Inbox'],
			['deleted', 'Inbox', null]
		]);
		expect(history('m2')).toEqual([
			['stored', null, 'Inbox'],
			['moved', 'Inbox', 'Inbox/Projects']
		]);
		expect(byId.get('m2')).toMatchObject({ deletedAt: null, folderId: projects?.id });
	});

	it('starts a folder again when Graph says its sync state has expired', async () => {
		let expired = true;
		const graph = mailbox({
			'mailFolders/inbox/messages/delta': () =>
				json({
					value: [message('m1', 'One')],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/old-d'
				}),
			'^/v1\\.0/old-d$': () => {
				if (expired) {
					expired = false;
					return graphError(410, 'SyncStateNotFound');
				}
				return empty();
			},
			'mailFolders/(sent|proj)/messages/delta': empty,
			'^/v1\\.0/empty-delta$': empty
		});
		const { row, context } = await setup(graph);
		await syncMailbox(context, row);
		const again = await syncMailbox(context, row);
		expect(again).toMatchObject({ added: 0, firstCopyDone: true });
	});

	it('stops after the current page when the service stops, and resumes from there', async () => {
		const graph = mailbox({
			'mailFolders/inbox/messages/delta': () =>
				json({
					value: [message('m1', 'One')],
					'@odata.nextLink': 'https://graph.microsoft.com/v1.0/inbox-p2'
				}),
			'^/v1\\.0/inbox-p2$': () =>
				json({
					value: [message('m2', 'Two')],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-d'
				}),
			'mailFolders/(sent|proj)/messages/delta': empty
		});
		const { db, row, context, stop } = await setup(graph);
		const realProgress = context.progress;
		const stopping: SyncContext = {
			...context,
			progress: (update) => {
				realProgress(update);
				stop();
			}
		};
		const first = await syncMailbox(stopping, row);
		expect(first).toMatchObject({ added: 1, stoppedEarly: true, firstCopyDone: false });
		expect(foldersOf(db, row.id).find((f) => f.graphId === 'inbox')?.deltaLink).toBe(
			'https://graph.microsoft.com/v1.0/inbox-p2'
		);
		expect(mailboxById(db, row.id)?.firstCopyDone).toBe(false);
	});

	it('gives folders whose safe names collide their own storage paths', () => {
		const paths = withUniqueStoragePaths([
			{ graphId: 'a', path: 'Q1: plan' },
			{ graphId: 'b', path: 'Q1? plan' }
		]).map((folder) => folder.storagePath);
		expect(paths).toEqual(['Q1_ plan', 'Q1_ plan ~2']);
	});
});

describe('one bad message never stops a folder', () => {
	const pageOf =
		(...ids: string[]) =>
		() =>
			json({
				value: ids.map((id) => message(id, `Subject ${id}`)),
				'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-delta-1'
			});

	it('records a message that cannot be copied, moves the folder on, and copies it later', async () => {
		let refusals = 1;
		const graph = mailbox({
			'mailFolders/inbox/messages/delta': pageOf('m1', 'm2', 'm3'),
			'^/v1\\.0/inbox-delta-1$': pageOf(),
			'mailFolders/(sent|proj)/messages/delta': empty,
			'^/v1\\.0/empty-delta$': empty
		})
			.on(/\/messages\/m2\/\$value$/, () => {
				if (refusals > 0) {
					refusals -= 1;
					return graphError(400, 'ErrorCorruptData', 'The item is corrupt');
				}
				return new Response('Subject: m2\r\n\r\nbody of m2');
			})
			// Deleted after the delta listed it: skipped, not a failure.
			.on(/\/messages\/m3\/\$value$/, () => graphError(404, 'ErrorItemNotFound', 'Not found'))
			.on(/\/messages\/m2\?\$select=/, () =>
				json({ ...message('m2', 'Subject m2'), parentFolderId: 'inbox' })
			);
		const { db, row, backupRoot, context } = await setup(graph);
		await syncMailbox(context, row);
		const stored = () =>
			db
				.select()
				.from(messages)
				.all()
				.map((each) => each.graphId)
				.sort();
		expect(stored()).toEqual(['m1']);
		const inbox = foldersOf(db, row.id).find((folder) => folder.graphId === 'inbox');
		expect(inbox?.deltaLink).toBe('https://graph.microsoft.com/v1.0/inbox-delta-1');
		expect(mailboxItemFailures(db, row.id)).toMatchObject([
			{ graphId: 'm2', attempts: 1, terminal: false, lastError: 'The item is corrupt' }
		]);
		// The streamed file is the message, and its SHA-256 matches.
		const first = db.select().from(messages).all()[0];
		const bytes = await readFile(join(backupRoot, ...(first?.filePath ?? '').split('/')));
		expect(first?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

		// Not due yet: nothing is tried.
		await syncMailbox(context, row);
		expect(stored()).toEqual(['m1']);
		// Due: tried again, copied, and no longer listed.
		const later: SyncContext = { ...context, now: () => 1000 + 16 * 60_000 };
		await syncMailbox(later, row);
		expect(stored()).toEqual(['m1', 'm2']);
		expect(mailboxItemFailures(db, row.id)).toEqual([]);
	});

	it('after a delta restart, marks deleted a message Microsoft 365 no longer has', async () => {
		let fresh = 0;
		const graph = mailbox({
			'mailFolders/inbox/messages/delta': () => {
				fresh += 1;
				return fresh === 1 ? pageOf('m1', 'm2')() : pageOf('m1')();
			},
			'^/v1\\.0/inbox-delta-1$': () => graphError(410, 'SyncStateNotFound', 'Expired'),
			'mailFolders/(sent|proj)/messages/delta': empty,
			'^/v1\\.0/empty-delta$': empty
		}).on(/\/messages\/m2\?\$select=/, () => graphError(404, 'ErrorItemNotFound', 'Not found'));
		const { db, row, context } = await setup(graph);
		await syncMailbox(context, row);
		// The second sync finds its delta link expired, starts again, and lists only m1.
		await syncMailbox(context, row);
		const gone = db
			.select()
			.from(messages)
			.all()
			.find((each) => each.graphId === 'm2');
		expect(gone?.deletedAt).not.toBeNull();
	});

	it('after a delta restart, marks deleted a message now in a folder Lookstow does not copy', async () => {
		let fresh = 0;
		const graph = mailbox({
			'mailFolders/inbox/messages/delta': () => {
				fresh += 1;
				return fresh === 1 ? pageOf('m1', 'm2', 'm3')() : pageOf('m1')();
			},
			'^/v1\\.0/inbox-delta-1$': () => graphError(410, 'SyncStateNotFound', 'Expired'),
			'mailFolders/(sent|proj)/messages/delta': empty,
			'^/v1\\.0/empty-delta$': empty
		})
			// Shift+Delete: still found by id, in the hidden Recoverable Items.
			.on(/\/messages\/m2\?\$select=/, () =>
				json({ ...message('m2', 'Subject m2'), parentFolderId: 'recoverable-deletions' })
			)
			// Moved to a folder Lookstow copies: that folder's sync records the move.
			.on(/\/messages\/m3\?\$select=/, () =>
				json({ ...message('m3', 'Subject m3'), parentFolderId: 'sent' })
			);
		const { db, row, context } = await setup(graph);
		await syncMailbox(context, row);
		await syncMailbox(context, row);
		const deleted = new Map(
			db
				.select()
				.from(messages)
				.all()
				.map((each) => [each.graphId, each.deletedAt !== null])
		);
		expect(deleted.get('m2')).toBe(true);
		expect(deleted.get('m3')).toBe(false);
	});
});

describe('the completeness check during a sync', () => {
	it("reads Microsoft's counts after the folders sync, not before", async () => {
		let listings = 0;
		const graph = mailbox({
			'mailFolders/inbox/messages/delta': () =>
				json({
					value: [message('m1', 'First'), message('m2', 'Second')],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-delta-1'
				}),
			'mailFolders/(sent|proj)/messages/delta': empty
		}).on(new RegExp(`^${INBOX}\\?`), () => {
			listings += 1;
			// One message arrived while the sync ran: the count before it would say 1.
			return json({
				value: [
					{ id: 'inbox', displayName: 'Inbox', childFolderCount: 1, totalItemCount: listings },
					{ id: 'sent', displayName: 'Sent Items', childFolderCount: 0, totalItemCount: 0 }
				]
			});
		});
		const { db, row, context } = await setup(graph);
		await syncMailbox(context, row);
		const inbox = foldersOf(db, row.id).find((folder) => folder.graphId === 'inbox');
		expect(listings).toBe(2);
		expect(inbox).toMatchObject({ sourceCount: 2, differsSince: null });
	});

	it('reads a folder that keeps differing again from the start, and measures items that are not messages', async () => {
		const graph = mailbox({
			'mailFolders/inbox/messages/delta\\?': () =>
				json({
					value: [message('m1', 'First'), message('m2', 'Second')],
					'@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-delta-1'
				}),
			// The saved delta link: nothing new, so a routine sync never finds m2.
			'^/v1\\.0/inbox-delta-1$': () =>
				json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/inbox-delta-1' }),
			'mailFolders/(sent|proj)/messages/delta': empty
		});
		const { db, row, context } = await setup(graph);
		const inbox = syncFolderList(
			db,
			row.id,
			[{ graphId: 'inbox', path: 'Inbox', storagePath: 'Inbox' }],
			1
		)[0];
		if (inbox === undefined) throw new Error('no folder');
		// Inbox was copied before, but its messages never reached the index; it has differed for an hour.
		saveFolderProgress(db, inbox.id, {
			deltaLink: 'https://graph.microsoft.com/v1.0/inbox-delta-1',
			firstCopyDone: true,
			now: 1
		});
		db.update(mailFolders)
			.set({ differsSince: new Date(1000 - 3_600_000) })
			.where(eq(mailFolders.id, inbox.id))
			.run();
		await syncMailbox(context, row);
		const after = foldersOf(db, row.id).find((folder) => folder.graphId === 'inbox');
		expect(graph.requests.some((url) => url.includes('/mailFolders/inbox/messages/delta?'))).toBe(
			true
		);
		// Microsoft counts 3; the full listing returned 2 messages, both now stored: one item is not
		// a message, so nothing is left unexplained.
		expect(after).toMatchObject({
			recheckedAt: new Date(1000),
			otherItemCount: 1,
			differsSince: null
		});
		expect(db.select().from(messages).where(eq(messages.folderId, inbox.id)).all()).toHaveLength(2);
	});
});
