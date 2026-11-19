import { isHttpError, isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { load } from './+page.server.ts';

/** What the load threw: SvelteKit ends a load with a redirect or an error by throwing it. */
function outcome(state: string): unknown {
	try {
		// The load reads only params; the rest of the event does not matter here.
		Reflect.apply(load, undefined, [{ params: { state } }]);
	} catch (thrown) {
		return thrown;
	}
	return null;
}

describe('links to a view of the mailboxes', () => {
	it('opens the Mailboxes page with its State list set', () => {
		const thrown = outcome('needs-look');
		expect(isRedirect(thrown) ? thrown.location : null).toBe('/mailboxes?state=needs-look');
		const checking = outcome('checking');
		expect(isRedirect(checking) ? checking.location : null).toBe('/mailboxes?state=checking');
	});

	it('refuses a state it does not know', () => {
		const thrown = outcome('everything');
		expect(isHttpError(thrown) ? thrown.status : null).toBe(404);
	});
});
