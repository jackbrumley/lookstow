import { hostname } from 'node:os';
import type { Queryable } from '../../database/connection.ts';
import { tlsFingerprint } from '../../crypto/tls-certificate.ts';
import { recordActivity } from '../activity/activity.ts';
import { readRemote, saveRemote, type RemoteSettings } from '../settings/settings.ts';
import { endSessionsOf, hashPassword } from './accounts.ts';
import { applyRemote, newRemoteCertificate, recentRemoteAudit, remoteProblem } from './listener.ts';
import {
	PASSWORD_MIN,
	parseAllowEntry,
	validUsername,
	type RemoteView
} from '../../../domain/remote.ts';

/**
 * Settings, Remote access (docs/specs/SPEC-REMOTE.md): turning it on and off, who may connect,
 * the certificate, and the accounts. Only the computer Lookstow runs on reaches these. Each
 * change applies to the listener at once and goes to the activity log; a refusal throws with
 * the reason in plain words.
 */
const RULE = 'Lookstow remote access';

export async function remoteView(db: Queryable, dataDir: string): Promise<RemoteView> {
	const remote = readRemote(db);
	const list = remote.allowList.length > 0 ? remote.allowList : ['<address>'];
	const port = String(remote.port);
	return {
		enabled: remote.enabled,
		port: remote.port,
		allowList: remote.allowList,
		address: `https://${hostname().toLowerCase()}:${port}/`,
		fingerprint: remote.certificatePem === null ? null : tlsFingerprint(remote.certificatePem),
		problem: remoteProblem(),
		accounts: remote.accounts.map(({ username, disabled, createdAt, lastSignInAt }) => ({
			username,
			disabled,
			createdAt,
			lastSignInAt
		})),
		firewall: {
			windows: `netsh advfirewall firewall add rule name="${RULE}" dir=in action=allow protocol=TCP localport=${port} remoteip=${list.join(',')}`,
			linux: list.map((entry) => `sudo ufw allow from ${entry} to any port ${port} proto tcp`)
		},
		audit: await recentRemoteAudit(dataDir)
	};
}

function note(db: Queryable, summary: string, detail: string | null = null): void {
	recordActivity(db, { level: 'info', kind: 'remote', actor: 'console', summary, detail });
}

/** Reads the allow-list a person typed: one address or range per line, comma or space. */
export function readAllowList(text: string): string[] {
	const entries = text
		.split(/[\s,;]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
	const wrong = entries.filter((entry) => parseAllowEntry(entry) === null);
	if (wrong.length > 0) {
		throw new Error(
			`Not an address or range: ${wrong.join(', ')}. Use addresses like 10.1.2.3, ranges like 10.1.2.0/24 (8 to 32), or an IPv6 address.`
		);
	}
	if (entries.length > 50) throw new Error('Keep the list to 50 addresses or ranges.');
	return [...new Set(entries)];
}

/** Saves whether remote access is on, its port and allow-list, and applies them. */
export async function saveRemoteAccess(
	db: Queryable,
	secretsKey: Buffer,
	change: { enabled: boolean; port: number; allowList: string[] }
): Promise<string> {
	if (!Number.isInteger(change.port) || change.port < 1024 || change.port > 65_535) {
		throw new Error('Choose a port from 1024 to 65535 (8443 is usual).');
	}
	const remote = readRemote(db);
	if (change.enabled && change.allowList.length === 0) {
		throw new Error('Add at least one address or range that may connect before turning it on.');
	}
	if (change.enabled && !remote.accounts.some((account) => !account.disabled)) {
		throw new Error('Add an account before turning remote access on.');
	}
	saveRemote(db, { ...remote, ...change });
	if (change.enabled && remote.certificatePem === null) newRemoteCertificate(db, secretsKey);
	const problem = await applyRemote(db, secretsKey);
	note(
		db,
		change.enabled ? 'Remote access was turned on or changed' : 'Remote access was turned off',
		`Port ${String(change.port)}; allowed: ${change.allowList.join(', ') || 'nobody'}.`
	);
	if (problem !== null) throw new Error(problem);
	return change.enabled
		? `Remote access is on at port ${String(change.port)} for ${String(change.allowList.length)} address${change.allowList.length === 1 ? '' : 'es or ranges'}.`
		: 'Remote access is off.';
}

export async function renewCertificate(db: Queryable, secretsKey: Buffer): Promise<string> {
	newRemoteCertificate(db, secretsKey);
	const problem = await applyRemote(db, secretsKey);
	note(db, 'A new remote access certificate was made');
	if (problem !== null) throw new Error(problem);
	return 'Made a new certificate. Browsers warn once more until each person accepts it again.';
}

function checkPassword(password: string, confirm: string): void {
	if (password.length < PASSWORD_MIN) {
		throw new Error(`Use a password of at least ${String(PASSWORD_MIN)} characters.`);
	}
	if (password.length > 200) throw new Error('Use a password of at most 200 characters.');
	if (password !== confirm) throw new Error('The two passwords are not the same.');
}

function withAccounts(
	db: Queryable,
	remote: RemoteSettings,
	accounts: RemoteSettings['accounts']
): void {
	saveRemote(db, { ...remote, accounts });
}

export async function addAccount(
	db: Queryable,
	username: string,
	password: string,
	confirm: string,
	now = Date.now()
): Promise<string> {
	if (!validUsername(username)) {
		throw new Error('Use 2 to 40 letters, digits, dots, dashes or underscores for the name.');
	}
	checkPassword(password, confirm);
	const remote = readRemote(db);
	const name = username.toLowerCase();
	if (remote.accounts.some((account) => account.username.toLowerCase() === name)) {
		throw new Error(`There is already an account called ${username}.`);
	}
	if (remote.accounts.length >= 20) throw new Error('Lookstow keeps at most 20 remote accounts.');
	withAccounts(db, remote, [
		...remote.accounts,
		{
			username,
			passwordHash: await hashPassword(password),
			disabled: false,
			createdAt: new Date(now).toISOString(),
			lastSignInAt: null
		}
	]);
	note(db, `Remote account ${username} was added`);
	return `Added ${username}. They sign in at the address above.`;
}

function existing(remote: RemoteSettings, username: string): RemoteSettings['accounts'][number] {
	const account = remote.accounts.find((each) => each.username === username);
	if (account === undefined) throw new Error(`There is no account called ${username}.`);
	return account;
}

export function setAccountDisabled(db: Queryable, username: string, disabled: boolean): string {
	const remote = readRemote(db);
	existing(remote, username);
	withAccounts(
		db,
		remote,
		remote.accounts.map((each) => (each.username === username ? { ...each, disabled } : each))
	);
	if (disabled) endSessionsOf(username);
	note(db, `Remote account ${username} was ${disabled ? 'disabled' : 'enabled'}`);
	return disabled ? `${username} is disabled and signed out.` : `${username} may sign in again.`;
}

export async function resetPassword(
	db: Queryable,
	username: string,
	password: string,
	confirm: string
): Promise<string> {
	checkPassword(password, confirm);
	const remote = readRemote(db);
	existing(remote, username);
	const passwordHash = await hashPassword(password);
	withAccounts(
		db,
		remote,
		remote.accounts.map((each) => (each.username === username ? { ...each, passwordHash } : each))
	);
	endSessionsOf(username);
	note(db, `The password of remote account ${username} was changed`);
	return `Changed ${username}'s password and signed them out.`;
}

export function deleteAccount(db: Queryable, username: string): string {
	const remote = readRemote(db);
	existing(remote, username);
	withAccounts(
		db,
		remote,
		remote.accounts.filter((each) => each.username !== username)
	);
	endSessionsOf(username);
	note(db, `Remote account ${username} was deleted`);
	return `Deleted ${username} and signed them out.`;
}
