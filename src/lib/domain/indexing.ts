import { formatCount, formatPercent } from '../utils/format.ts';

/**
 * Work the search index does once after an update (docs/specs/SPEC-SCALE.md), shown in a banner
 * on every page and in the Log, so a slower search meanwhile is explained.
 */
export type IndexingProgress =
	| { stage: 'search-index'; done: number; total: number }
	| { stage: 'content-waiting' }
	| { stage: 'content-moving'; done: number; total: number };

function percentOf(done: number, total: number): number {
	return total === 0 ? 100 : Math.min(100, (done / total) * 100);
}

/** The banner's words, or null when nothing is under way. */
export function indexingText(progress: IndexingProgress | null): string | null {
	if (progress === null) return null;
	switch (progress.stage) {
		case 'search-index':
			return `Building the search index after the update: ${formatCount(progress.done)} of ${formatCount(progress.total)} messages (${formatPercent(percentOf(progress.done, progress.total))}). Search is slower until it is done; backups carry on.`;
		case 'content-waiting':
			return `The search index is built. The AI tools' text index moves to its own file once the update has settled; until then their body and attachment filters find nothing.`;
		case 'content-moving':
			return `Moving the AI tools' text index to its own file: ${formatCount(progress.done)} of ${formatCount(progress.total)} messages (${formatPercent(percentOf(progress.done, progress.total))}). Their body and attachment filters work once it is done.`;
	}
}

/** The Log's line for a step, every tenth of the way. */
export function progressLine(what: string, done: number, total: number): string {
	return `${what}: ${formatCount(done)} of ${formatCount(total)} messages (${formatPercent(percentOf(done, total))})`;
}
