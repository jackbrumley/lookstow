import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../database/connection.ts';
import { aiCaller, aiToolsWanted } from '../ai/access.ts';
import { readRemote, saveRemote, type RemoteSettings } from '../settings/settings.ts';
import { accountForAiToken, bearerToken, makeAiToken } from './ai-tokens.ts';
import { addAccount, newAccountAiToken, setAccountAiTools, updateAccount } from './manage.ts';
import { isAiPath, remoteAiMayOpen } from '../../../domain/remote.ts';

describe('the AI tools on the remote address', () => {
	it('are /mcp and the downloads it links to, and only read', () => {
		expect(isAiPath('/mcp')).toBe(true);
		expect(isAiPath('/mcp/attachments/a/1')).toBe(true);
		expect(isAiPath('/mcpx')).toBe(false);
		expect(isAiPath('/messages/1')).toBe(false);
		expect(remoteAiMayOpen('POST', '/mcp')).toBe(true);
		expect(remoteAiMayOpen('GET', '/mcp')).toBe(false);
		expect(remoteAiMayOpen('GET', '/mcp/attachments/abc/3')).toBe(true);
		expect(remoteAiMayOpen('GET', '/mcp/evidence-packs/abc/download')).toBe(true);
		expect(remoteAiMayOpen('POST', '/mcp/attachments/abc/3')).toBe(false);
		expect(remoteAiMayOpen('GET', '/mcp/anything-else')).toBe(false);
	});

	it('take a token of an allowed, enabled account, and nothing else', async () => {
		const db = openDatabase(':memory:');
		await addAccount(db, 'ann', 'correct horse battery', 'correct horse battery');
		await addAccount(db, 'bob', 'correct horse battery', 'correct horse battery');
		const remote = (): RemoteSettings => readRemote(db);
		expect(remote().accounts[0]).toMatchObject({ aiTools: false, aiTokenSha256: null });

		const first = setAccountAiTools(db, 'ann', true).token;
		expect(first).toMatch(/^lksr_/);
		expect(accountForAiToken(remote(), first)?.username).toBe('ann');
		expect(accountForAiToken(remote(), 'lksr_wrong')).toBeNull();
		expect(accountForAiToken(remote(), null)).toBeNull();
		// Only its SHA-256 and last four characters are kept.
		expect(JSON.stringify(remote())).not.toContain(first ?? 'none');

		const second = newAccountAiToken(db, 'ann').token;
		expect(accountForAiToken(remote(), first)).toBeNull();
		expect(accountForAiToken(remote(), second)?.username).toBe('ann');
		expect(() => newAccountAiToken(db, 'bob')).toThrow(/not allowed/);

		saveRemote(db, {
			...remote(),
			accounts: remote().accounts.map((account) => ({ ...account, disabled: true }))
		});
		expect(accountForAiToken(remote(), second)).toBeNull();
		saveRemote(db, {
			...remote(),
			accounts: remote().accounts.map((account) => ({ ...account, disabled: false }))
		});
		setAccountAiTools(db, 'ann', false);
		expect(accountForAiToken(remote(), second)).toBeNull();
		expect(remote().accounts[0]).toMatchObject({ aiTools: false, aiTokenSha256: null });
	});

	it('name who is calling, and keep the content index reading while anyone may use them', async () => {
		const db = openDatabase(':memory:');
		expect(aiCaller(db, { remoteAiUser: 'ann' }, null)).toEqual({ ok: true, who: 'ann' });
		expect(aiCaller(db, { remoteAiUser: null }, 'Bearer x')).toMatchObject({ ok: false });
		expect(aiToolsWanted(db)).toBe(false);
		await addAccount(db, 'ann', 'correct horse battery', 'correct horse battery');
		setAccountAiTools(db, 'ann', true);
		expect(aiToolsWanted(db)).toBe(false);
		saveRemote(db, { ...readRemote(db), enabled: true });
		expect(aiToolsWanted(db)).toBe(true);
	});

	it('are set with the rest of an account in its Edit window, only what changed', async () => {
		const db = openDatabase(':memory:');
		await addAccount(db, 'ann', 'correct horse battery', 'correct horse battery');
		const ann = () => readRemote(db).accounts[0];

		const same = updateAccount(db, 'ann', {
			canSignIn: true,
			evidencePacks: false,
			aiTools: false
		});
		expect(same).toEqual({ message: 'Nothing changed for ann.', token: null });

		const on = updateAccount(db, 'ann', { canSignIn: false, evidencePacks: true, aiTools: true });
		expect(on.token).toMatch(/^lksr_/);
		expect(ann()).toMatchObject({ disabled: true, evidencePacks: true, aiTools: true });
		const hint = ann()?.aiTokenHint;

		// Saving again with AI tools still on keeps the token: no new one to send.
		const again = updateAccount(db, 'ann', { canSignIn: true, evidencePacks: true, aiTools: true });
		expect(again.token).toBeNull();
		expect(ann()).toMatchObject({ disabled: false, aiTokenHint: hint });
		expect(() =>
			updateAccount(db, 'nobody', { canSignIn: true, evidencePacks: false, aiTools: false })
		).toThrow();
	});

	it('reads a bearer token', () => {
		expect(bearerToken('Bearer abc')).toBe('abc');
		expect(bearerToken('bearer  abc')).toBe('abc');
		expect(bearerToken('Basic abc')).toBeNull();
		expect(bearerToken(null)).toBeNull();
		expect(makeAiToken().hint).toHaveLength(4);
	});
});
