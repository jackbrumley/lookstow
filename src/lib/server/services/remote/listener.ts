import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Queryable } from '../../database/connection.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import { makeTlsCertificate } from '../../crypto/tls-certificate.ts';
import { errorText, serverLog } from '../../log.ts';
import { readRemote, saveRemote } from '../settings/settings.ts';
import type { RemoteAuditLine } from '../../../domain/remote.ts';

/**
 * Remote access's running side (docs/specs/SPEC-REMOTE.md): the HTTPS listener that server.ts
 * owns, started, changed and stopped from Settings through the control server.ts puts on
 * globalThis; the self-signed certificate it serves; and the audit trail of what remote people
 * opened.
 */
type RemoteConfig = { port: number; key: string; cert: string };
type ListenerControl = { apply: (config: RemoteConfig | null) => Promise<string | null> };

function isControl(value: unknown): value is ListenerControl {
	return (
		typeof value === 'object' &&
		value !== null &&
		'apply' in value &&
		typeof value.apply === 'function'
	);
}

/** Why remote access is not running now, or null; kept for the Settings card. */
let problem: string | null = null;

export function remoteProblem(): string | null {
	return problem;
}

/** This computer's names and addresses, for the certificate. */
function ownNames(): string[] {
	const addresses = Object.values(networkInterfaces())
		.flat()
		.flatMap((entry) => (entry === undefined ? [] : [entry.address.replace(/%.*$/, '')]));
	return [...new Set([hostname().toLowerCase(), 'localhost', ...addresses])];
}

/** A new self-signed certificate for the listener (the old one stops being served). */
export function newRemoteCertificate(db: Queryable, secretsKey: Buffer, now = Date.now()): void {
	const made = makeTlsCertificate(hostname().toLowerCase(), ownNames(), now);
	saveRemote(db, {
		...readRemote(db),
		certificatePem: made.certificatePem,
		sealedKey: sealSecret(Buffer.from(made.privateKeyPem), secretsKey)
	});
}

/** Starts, changes or stops the listener to match Settings; returns why it is not running. */
export async function applyRemote(db: Queryable, secretsKey: Buffer): Promise<string | null> {
	const control: unknown = Reflect.get(globalThis, 'lookstow.remoteListener');
	const remote = readRemote(db);
	if (!isControl(control)) {
		problem = remote.enabled
			? 'Remote access runs only in the installed service, not in a development run.'
			: null;
		return problem;
	}
	if (!remote.enabled || remote.certificatePem === null || remote.sealedKey === null) {
		problem = null;
		await control.apply(null);
		return null;
	}
	let key: string;
	try {
		key = openSecret(remote.sealedKey, secretsKey).toString('utf8');
	} catch {
		problem =
			"Remote access could not start: the certificate's key cannot be opened with this SECRETS_KEY. Make a new certificate below.";
		serverLog('error', 'remote', problem);
		return problem;
	}
	try {
		problem = await control.apply({ port: remote.port, key, cert: remote.certificatePem });
	} catch (error) {
		problem = `Remote access could not start: ${errorText(error)}`;
	}
	if (problem !== null) serverLog('error', 'remote', problem);
	return problem;
}

const AUDIT_FOLDER = 'remote-audit';

/** Appends a line to `<data>/remote-audit/YYYY-MM-DD.jsonl`; a failure goes to the log. */
export async function auditRemote(dataDir: string, line: RemoteAuditLine): Promise<void> {
	try {
		const folder = join(dataDir, AUDIT_FOLDER);
		await mkdir(folder, { recursive: true });
		await appendFile(join(folder, `${line.at.slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`, {
			mode: 0o600
		});
	} catch (error) {
		serverLog('warn', 'remote', `Could not write the remote audit trail: ${errorText(error)}`);
	}
}

function isAuditLine(value: unknown): value is RemoteAuditLine {
	return typeof value === 'object' && value !== null && 'path' in value && 'at' in value;
}

/** The newest `most` lines of the audit trail (today's and yesterday's files), newest first. */
export async function recentRemoteAudit(dataDir: string, most = 50): Promise<RemoteAuditLine[]> {
	const folder = join(dataDir, AUDIT_FOLDER);
	let files: string[];
	try {
		files = (await readdir(folder))
			.filter((name) => name.endsWith('.jsonl'))
			.sort()
			.slice(-2);
	} catch {
		return [];
	}
	const lines: RemoteAuditLine[] = [];
	for (const file of files) {
		const text = await readFile(join(folder, file), 'utf8').catch(() => '');
		for (const row of text.split('\n')) {
			if (row.trim() === '') continue;
			try {
				const parsed: unknown = JSON.parse(row);
				if (isAuditLine(parsed)) lines.push(parsed);
			} catch {
				// A torn last line after a crash: skipped.
			}
		}
	}
	return lines.slice(-most).reverse();
}
