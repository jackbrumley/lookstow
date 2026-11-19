import { describe, expect, it } from 'vitest';
import { FakeGraph, TEST_CREDENTIALS, graphError, json } from '#tests/support/fake-graph.ts';
import { backoffMs, GraphClient, GraphError, parseGraphJson } from './client.ts';
import { TokenSource } from './token.ts';

describe('reading JSON from Graph', () => {
	it('accepts raw control characters inside strings, keeping each value exact', () => {
		// As the mailbox export API sends them: a raw tab, line feed and U+0001 inside values.
		const raw = `{\n\t"value": [{"itemId": "a\u0001b", "message": "line 1\nline 2\tend \\"q\\""}]\n}`;
		expect(() => {
			JSON.parse(raw);
		}).toThrow(SyntaxError);
		expect(parseGraphJson(raw)).toEqual({
			value: [{ itemId: 'a\u0001b', message: 'line 1\nline 2\tend "q"' }]
		});
	});

	it('still refuses JSON that is wrong in any other way', () => {
		expect(() => parseGraphJson('{"value": [')).toThrow(SyntaxError);
		expect(() => parseGraphJson('{"a": 1,}')).toThrow(SyntaxError);
		expect(() => parseGraphJson('{"a": "x\u0001"')).toThrow(SyntaxError);
	});

	it('posts an export and reads a reply that holds a raw control character', async () => {
		const graph = new FakeGraph()
			.withToken()
			.on(
				'/beta/admin/exchange/mailboxes/MBX:a@b/exportItems',
				() => new Response(`{"value":[{"itemId":"i1","data":"QUJD","note":"x\u0007y"}]}`)
			);
		const client = new GraphClient(
			new TokenSource(TEST_CREDENTIALS, graph.fetch),
			graph.fetch,
			() => Promise.resolve()
		);
		await expect(
			client.postJson(
				'https://graph.microsoft.com/beta/admin/exchange/mailboxes/MBX:a@b/exportItems',
				{
					itemIds: ['i1']
				}
			)
		).resolves.toEqual({ value: [{ itemId: 'i1', data: 'QUJD', note: 'x\u0007y' }] });
	});
});

function client(graph: FakeGraph, sleeps: number[] = []): GraphClient {
	return new GraphClient(new TokenSource(TEST_CREDENTIALS, graph.fetch), graph.fetch, (ms) => {
		sleeps.push(ms);
		return Promise.resolve();
	});
}

describe('the Graph client', () => {
	it('waits as long as Retry-After says when throttled, then carries on', async () => {
		let calls = 0;
		const graph = new FakeGraph().withToken().on('/v1.0/me', () => {
			calls += 1;
			return calls === 1 ? json({}, 429, { 'retry-after': '7' }) : json({ ok: true });
		});
		const sleeps: number[] = [];
		await expect(client(graph, sleeps).getJson('/v1.0/me')).resolves.toEqual({ ok: true });
		expect(sleeps).toEqual([7000]);
	});

	it('gives up after six attempts and says why', async () => {
		const graph = new FakeGraph()
			.withToken()
			.on('/v1.0/me', () => graphError(503, 'ServiceUnavailable'));
		const sleeps: number[] = [];
		await expect(client(graph, sleeps).getJson('/v1.0/me')).rejects.toBeInstanceOf(GraphError);
		expect(sleeps).toHaveLength(5);
	});

	it('asks again when Graph sends an empty reply, and fails clearly if it keeps doing so', async () => {
		let calls = 0;
		const graph = new FakeGraph().withToken().on('/v1.0/me', () => {
			calls += 1;
			return calls === 1 ? new Response('', { status: 200 }) : json({ ok: true });
		});
		await expect(client(graph).getJson('/v1.0/me')).resolves.toEqual({ ok: true });
		const empty = new FakeGraph()
			.withToken()
			.on('/v1.0/me', () => new Response('', { status: 200 }));
		await expect(client(empty).getJson('/v1.0/me')).rejects.toMatchObject({ code: 'empty-reply' });
	});

	it('asks again when a reply is cut off, garbled or ends early', async () => {
		const cutOff = () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"value":'));
						controller.error(new TypeError('terminated'));
					}
				})
			);
		let calls = 0;
		const graph = new FakeGraph().withToken().on('/v1.0/me', () => {
			calls += 1;
			if (calls === 1) return cutOff();
			if (calls === 2) return new Response('{"value": [', { status: 200 });
			return json({ ok: true });
		});
		await expect(client(graph).getJson('/v1.0/me')).resolves.toEqual({ ok: true });
		expect(calls).toBe(3);
		const broken = new FakeGraph().withToken().on('/v1.0/me', cutOff);
		await expect(client(broken).getBytes('/v1.0/me')).rejects.toMatchObject({
			code: 'broken-reply'
		});
	});

	it('asks again when signing in times out', async () => {
		let tries = 0;
		const graph = new FakeGraph()
			.on(/\/oauth2\/v2\.0\/token$/, () => {
				tries += 1;
				if (tries === 1) throw new TypeError('fetch failed');
				return json({ access_token: 'token', expires_in: 3600 });
			})
			.on('/v1.0/me', () => json({ ok: true }));
		await expect(client(graph).getJson('/v1.0/me')).resolves.toEqual({ ok: true });
		expect(tries).toBe(2);
	});

	it('does not retry a refusal', async () => {
		const graph = new FakeGraph()
			.withToken()
			.on('/v1.0/me', () =>
				graphError(403, 'Authorization_RequestDenied', 'Insufficient privileges')
			);
		await expect(client(graph).getJson('/v1.0/me')).rejects.toMatchObject({
			status: 403,
			code: 'Authorization_RequestDenied',
			message: 'Insufficient privileges'
		});
	});

	it('follows nextLink through every page', async () => {
		const graph = new FakeGraph()
			.withToken()
			.on('/v1.0/users', () =>
				json({
					value: [1, 2],
					'@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=b'
				})
			)
			.on('/v1.0/users?$skiptoken=b', () => json({ value: [3] }));
		const items: unknown[] = [];
		for await (const page of client(graph).pages('/v1.0/users')) {
			items.push(...page.items);
		}
		expect(items).toEqual([1, 2, 3]);
	});

	it('never sends the token anywhere but Microsoft Graph', async () => {
		const graph = new FakeGraph().withToken();
		await expect(client(graph).getJson('https://example.com/steal')).rejects.toThrow(
			/Refusing to send the Graph token/
		);
	});

	it('backs off exponentially without Retry-After, capped at two minutes', () => {
		expect([1, 2, 3, 10].map((attempt) => backoffMs(attempt, null))).toEqual([
			2000, 4000, 8000, 120_000
		]);
	});
});
