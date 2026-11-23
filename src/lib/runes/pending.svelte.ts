/**
 * What someone just asked for (Sync all now, Discover now, Check again now), shown at once: the
 * side bar and the button say "Starting…" from the click, before the engine's next status says
 * it is under way. The live status takes over as soon as it shows the work (`settle`), and a
 * request it never shows is dropped after PENDING_MS, so a lost request does not linger.
 */
import type { EngineStatus } from '#lib/domain/engine.ts';

export type PendingKind = 'sync-all' | 'discover' | 'check-again';

type Pending = { kind: PendingKind; text: string; at: number };

const PENDING_MS = 20_000;

let current = $state<Pending | null>(null);

export const pending = {
	get current(): Pending | null {
		return current;
	},
	/** Shows the request at once. */
	start(kind: PendingKind, text: string): void {
		const started: Pending = { kind, text, at: Date.now() };
		current = started;
		setTimeout(() => {
			if (current === started) current = null;
		}, PENDING_MS);
	},
	/** The request failed: nothing is starting. */
	clear(): void {
		current = null;
	},
	/** The engine's status shows the work under way (or done): the status speaks from here. */
	settle(engine: EngineStatus): void {
		if (current === null) return;
		const underWay =
			current.kind === 'discover'
				? engine.discovery.running
				: current.kind === 'sync-all'
					? engine.syncAll
					: engine.syncing.length > 0;
		if (underWay) current = null;
	}
};
