import type { EngineStatus } from './engine.ts';
import type { ThroughputView } from './throughput.ts';

/**
 * What Lookstow is doing now, taken at one moment (docs/specs/SPEC-STATUS.md): the engine and
 * the governor read together. Every page's live state (the side bar, the dashboard, the Speed
 * card, the Mailboxes page's syncing badges) comes from this one object, so no two parts of the
 * console can disagree about whether something is running.
 */
export type LiveStatus = {
	at: string;
	engine: EngineStatus;
	speed: ThroughputView;
};

/** The side bar's one-line summary of the work in hand. */
export function phaseText(live: LiveStatus): string {
	const { engine } = live;
	if (engine.pause.paused) return 'Paused';
	if (engine.discovery.running) return 'Finding mailboxes';
	if (engine.syncing.length > 0) {
		return `Backing up ${String(engine.syncing.length)} mailbox${engine.syncing.length === 1 ? '' : 'es'}`;
	}
	return 'Idle';
}

/** Whether anything is running, so pages follow the work closely and rest when there is none. */
export function isBusy(live: LiveStatus): boolean {
	return live.engine.syncing.length > 0 || live.engine.discovery.running;
}

/**
 * Combinations a single snapshot must never show. Each is a sentence naming what disagrees;
 * an empty list means the snapshot is consistent. The server logs any it finds.
 */
export function statusContradictions(live: LiveStatus): string[] {
	const { engine, speed } = live;
	const found: string[] = [];
	const ids = engine.syncing.map((sync) => sync.mailboxId);
	if (new Set(ids).size !== ids.length) {
		found.push('A mailbox is listed as syncing twice');
	}
	if (speed.service.engine.mailboxesSyncing !== engine.syncing.length) {
		found.push(
			`The Speed card counts ${String(speed.service.engine.mailboxesSyncing)} mailboxes syncing; the engine runs ${String(engine.syncing.length)}`
		);
	}
	if (speed.service.engine.paused !== engine.pause.paused) {
		found.push('The Speed card and the engine disagree about Pause');
	}
	if (engine.slots.current > engine.slots.maximum) {
		found.push(
			`${String(engine.slots.current)} mailboxes at once is above the limit of ${String(engine.slots.maximum)}`
		);
	}
	if (engine.relayout !== null && engine.syncing.length > 0) {
		found.push('A sync runs while files move into the date layout');
	}
	if (engine.discovery.running && engine.discovery.nextAt !== null) {
		found.push('Discovery is running and also shows its next time');
	}
	if (speed.pace.phase === 'idle' && speed.pace.inFlight > 0) {
		found.push('The pace says idle while requests are in flight');
	}
	return found;
}

/** The dependency key the live status loads with; invalidating it refreshes every live view. */
export const LIVE_STATUS = 'lookstow:status';

/** How often pages refresh the live status: closely while work runs, gently when idle. */
export function refreshAfterMs(live: LiveStatus): number {
	return isBusy(live) ? 4_000 : 30_000;
}
