import { mkdtemp, readFile } from 'node:fs/promises';
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
import { TokenSource } from '../graph/token.ts';
import { applyDiscovery, foldersOf, mailboxById } from '../mailboxes/repository.ts';
import { messages } from '../../database/schema.ts';
import { syncMailbox, withUniqueStoragePaths, type SyncContext } from './mailbox-sync.ts';

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
					{ id: 'inbox', displayName: 'Inbox', childFolderCount: 1 },
					{ id: 'sent', displayName: 'Sent Items', childFolderCount: 0 }
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
		client: new GraphClient(new TokenSource(TEST_CREDENTIALS, graph.fetch), graph.fetch, noSleep),
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
			/^ann@example.com\/Inbox\/2026\/2026-03-04_050607_First_[0-9a-f]{10}\.eml$/
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
