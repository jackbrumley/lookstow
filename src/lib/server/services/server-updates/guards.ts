/**
 * Who may ask for a release check or an update. The console has no sign-in: it listens on
 * 127.0.0.1, so whoever can open it is at this computer. A web page somewhere else must not be
 * able to press the buttons for them, so a write is accepted only when
 *
 * - it was addressed to this computer by a loopback name (a DNS rebinding page reaches
 *   127.0.0.1 under its own host name), and
 * - the browser says it came from the console itself (`Origin` equal to the console's origin).
 *   Every browser sends `Origin` on a POST; tools that send none are refused too.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type WriteCheck = { kind: 'allowed' } | { kind: 'refused'; reason: string };

export function consoleWrite(request: Request, url: URL): WriteCheck {
	if (!LOOPBACK_HOSTS.has(url.hostname)) {
		return {
			kind: 'refused',
			reason: `Open the console at http://127.0.0.1:${url.port === '' ? '80' : url.port} to do this.`
		};
	}
	if (request.headers.get('origin') !== url.origin) {
		return { kind: 'refused', reason: 'This request did not come from the Lookstow console.' };
	}
	return { kind: 'allowed' };
}
