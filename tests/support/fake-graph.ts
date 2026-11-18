/**
 * A stand-in for Microsoft Graph and Entra in tests: routes match on method and path (with the
 * query), reply with JSON or bytes, and every request is recorded.
 */
export type Route = {
	match: (url: URL, init: RequestInit | undefined) => boolean;
	reply: (url: URL) => Response;
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

export function graphError(status: number, code: string, message = code): Response {
	return json({ error: { code, message } }, status);
}

export class FakeGraph {
	readonly requests: string[] = [];
	readonly #routes: Route[] = [];

	on(test: string | RegExp, reply: (url: URL) => Response): this {
		this.#routes.push({
			match: (url) => {
				const target = `${url.pathname}${url.search}`;
				return typeof test === 'string'
					? decodeURIComponent(target) === test
					: test.test(decodeURIComponent(target));
			},
			reply
		});
		return this;
	}

	/** Entra's token endpoint, answering every sign-in. */
	withToken(): this {
		this.on(/\/oauth2\/v2\.0\/token$/, () => json({ access_token: 'token', expires_in: 3600 }));
		return this;
	}

	readonly fetch = (input: string, init?: RequestInit): Promise<Response> => {
		const url = new URL(input);
		this.requests.push(decodeURIComponent(`${url.pathname}${url.search}`));
		// The last matching route wins, so a test can override one set up earlier.
		const route = this.#routes.findLast((candidate) => candidate.match(url, init));
		if (route === undefined) {
			return Promise.resolve(
				graphError(404, 'ResourceNotFound', `No fake route for ${url.pathname}${url.search}`)
			);
		}
		return Promise.resolve(route.reply(url));
	};
}

export const TEST_CREDENTIALS = {
	tenantId: '00000000-0000-0000-0000-000000000001',
	clientId: '00000000-0000-0000-0000-000000000002',
	auth: { kind: 'secret' as const, secret: 'a-test-secret-value' }
};

export const noSleep = (): Promise<void> => Promise.resolve();
