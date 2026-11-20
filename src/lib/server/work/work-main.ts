import { parentPort, type MessagePort } from 'node:worker_threads';
import { openDatabase } from '../database/connection.ts';
import { slowQueries } from '../database/slow-queries.ts';
import { dataDir } from '../data-dir.ts';
import { env } from '../env.ts';
import { errorText, sendLogTo, serverLog } from '../log.ts';
import { notifyActivity, pruneActivity } from '../services/activity/activity.ts';
import { contentIndexProgress, startContentIndexer } from '../services/ai/content-index.ts';
import { Alerts } from '../services/alerts/alerts.ts';
import { Engine } from '../services/engine/engine.ts';
import { liveStatus } from '../services/engine/live-status.ts';
import { startSearchIndex } from '../services/search-index/keeper.ts';
import { effectiveBackupRoot, readAiAccess } from '../services/settings/settings.ts';
import { throughputExtras } from '../services/throughput/extras.ts';
import {
	forgetLearnedPace,
	learnedPace,
	startThroughputMonitor
} from '../services/throughput/monitor.ts';
import {
	isToWork,
	type FromWork,
	type WorkAnswer,
	type WorkCall,
	type WorkSnapshot
} from './protocol.ts';
import { threadHealth, watchThread } from './thread-health.ts';

/**
 * The work thread (docs/specs/SPEC-SCALE.md): its own database connection, the backup engine,
 * email alerts, the throughput monitor, the search and content indexes and the AI tools. It
 * answers the web thread's calls and sends it a snapshot of the engine every second.
 */
function workPort(): MessagePort {
	if (parentPort === null) throw new Error('work-main.ts runs on the work thread only');
	return parentPort;
}
const port = workPort();
const post = (message: FromWork): void => {
	port.postMessage(message);
};
sendLogTo((level, area, message, at) => {
	post({ type: 'log', level, area, message, at });
});

const SNAPSHOT_EVERY_MS = 1_000;
const ACTIVITY_DAYS = 90;

const db = openDatabase(env.databasePath);
const folder = dataDir();
const engine = new Engine({ db, dataDir: folder, secretsKey: env.secretsKey });
// The governor starts from the pace learned before (before any Graph request), and alerts listen
// before anything can record activity.
const throughput = startThroughputMonitor(db, folder, () => throughputExtras(engine.status()));
const alerts = new Alerts({ db, secretsKey: env.secretsKey });
alerts.start();
engine.start();
const contentIndex = startContentIndexer(
	db,
	() => effectiveBackupRoot(db, folder),
	() => readAiAccess(db).enabled
);
const searchIndex = startSearchIndex(db);
const stopWatching = watchThread('work');
// The activity log keeps 90 days (the Activity page says so).
const prune = (): void => {
	pruneActivity(db, ACTIVITY_DAYS);
};
prune();
const pruning = setInterval(prune, 24 * 60 * 60_000);

/** The content index's count for the snapshot, taken at most every 30 seconds. */
let counted: { value: WorkSnapshot['contentIndex']; at: number } | null = null;
function contentCount(): WorkSnapshot['contentIndex'] {
	if (counted === null || Date.now() - counted.at >= 30_000) {
		counted = { value: contentIndexProgress(db), at: Date.now() };
	}
	return counted.value;
}

function snapshot(): WorkSnapshot {
	return {
		live: liveStatus(engine),
		learnedPace: learnedPace(),
		lockdown: engine.lockdown(),
		slowQueries: slowQueries(),
		health: threadHealth(),
		indexing: searchIndex.progress(),
		contentIndex: contentCount()
	};
}

/** A snapshot that fails (a broken setting) is logged once a minute; the thread carries on. */
let failedAt = 0;
function trySnapshot(): WorkSnapshot | null {
	try {
		return snapshot();
	} catch (error) {
		if (Date.now() - failedAt >= 60_000) {
			failedAt = Date.now();
			serverLog('error', 'work', `Could not take the engine's snapshot: ${errorText(error)}`);
		}
		return null;
	}
}

function sendSnapshot(): void {
	const taken = trySnapshot();
	if (taken !== null) post({ type: 'snapshot', snapshot: taken });
}

const ticking = setInterval(sendSnapshot, SNAPSHOT_EVERY_MS);

async function answer(call: WorkCall): Promise<WorkAnswer> {
	switch (call.name) {
		case 'requestDiscovery':
			engine.requestDiscovery();
			return { name: 'done' };
		case 'requestSync':
			engine.requestSync(call.mailboxIds);
			return { name: 'done' };
		case 'cancel':
			engine.cancel(call.mailboxId);
			return { name: 'done' };
		case 'pause':
			engine.pause(call.reason, call.actor, call.detail);
			return { name: 'done' };
		case 'resume':
			engine.resume(call.actor);
			return { name: 'done' };
		case 'waitUntilIdle':
			return { name: 'idle', value: await engine.waitUntilIdle(call.mailboxId, call.ms) };
		case 'startMove':
			await engine.startMove(call.to, call.actor);
			return { name: 'done' };
		case 'cancelMove':
			engine.cancelMove(call.actor);
			return { name: 'done' };
		case 'removeOldCopy':
			engine.removeOldCopy(call.actor);
			return { name: 'done' };
		case 'sendTestAlert':
			return { name: 'testAlert', value: await alerts.sendTest(call.recipient, call.by) };
		case 'forgetPace':
			forgetLearnedPace(db);
			return { name: 'done' };
	}
}

async function stop(): Promise<void> {
	clearInterval(ticking);
	clearInterval(pruning);
	await engine.stop();
	await Promise.all([throughput.stop(), contentIndex.stop(), searchIndex.stop()]);
	alerts.stop();
	stopWatching();
	db.$client.close();
	post({ type: 'stopped' });
	sendLogTo(null);
	port.close();
}

port.on('message', (message: unknown) => {
	if (!isToWork(message)) return;
	switch (message.type) {
		case 'call': {
			const { id, call } = message;
			answer(call).then(
				(reply) => {
					post({ type: 'answer', id, answer: reply, snapshot: trySnapshot() });
				},
				(error: unknown) => {
					post({ type: 'failed', id, error: errorText(error), snapshot: trySnapshot() });
				}
			);
			return;
		}
		case 'activity':
			notifyActivity(db, message.entry, message.now);
			return;
		case 'stop':
			void stop().catch((error: unknown) => {
				serverLog('error', 'work', `The work thread did not stop cleanly: ${errorText(error)}`);
				port.close();
			});
			return;
	}
});

sendSnapshot();
// Started even if the snapshot failed (a broken setting): the console then starts and shows the
// error, instead of never answering.
post({ type: 'started' });
serverLog('info', 'work', 'The work thread started: backup engine, alerts and indexes');
