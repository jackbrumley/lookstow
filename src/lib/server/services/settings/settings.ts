import { eq } from 'drizzle-orm';
import type { UpdateReminderState } from '../../../domain/releases/update-reminder.ts';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { Queryable } from '../../database/connection.ts';
import { settings } from '../../database/schema.ts';
import { certificateFacts } from '../../crypto/app-certificate.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import type { GraphCredentials } from '../graph/token.ts';
import {
	ALERT_TYPES,
	MAILGUN_REGIONS,
	type AlertRecipient,
	type MailgunRegion,
	type MailgunView
} from '../../../domain/alerts.ts';
import {
	SCHEDULE_DEFAULTS,
	SCHEDULE_LIMITS,
	DISK_DEFAULTS,
	SCOPE_DEFAULTS,
	UPDATE_DEFAULTS,
	type DiskSettings,
	type BackupSettings,
	type BackupMoveState,
	type ConnectionView,
	type ScheduleSettings,
	type ScopeSettings,
	type SettingsView,
	type UpdateSettings
} from '../../../domain/settings.ts';

/**
 * The one owner of the settings table. Each setting is a key with a JSON value, validated with
 * zod on every read. Secrets (the client secret, the certificate's private key) are sealed with
 * SECRETS_KEY before they are stored and opened only to sign in.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const connectionSchema = z.object({
	tenantId: z.string().regex(GUID, 'The tenant ID is a GUID').or(z.literal('')),
	clientId: z.string().regex(GUID, 'The application (client) ID is a GUID').or(z.literal('')),
	auth: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('none') }),
		z.object({
			kind: z.literal('secret'),
			sealedSecret: z.string(),
			hint: z.string(),
			setAt: z.string()
		}),
		z.object({
			kind: z.literal('certificate'),
			certificatePem: z.string(),
			sealedPrivateKey: z.string()
		})
	])
});
type StoredConnection = z.infer<typeof connectionSchema>;

const addressList = z.array(z.string().trim().toLowerCase().pipe(z.email()));

const scopeSchema = z.object({
	// Added after 0.1.0: a scope saved by 0.1.0 has neither, and means every mailbox.
	mode: z.enum(['all', 'selected']).default('all'),
	selectedAddresses: addressList.default([]),
	includeShared: z.boolean(),
	includeResources: z.boolean(),
	includeArchives: z.boolean(),
	// Added in 0.13.3: Recoverable Items and the mailbox root, off unless chosen.
	includeRecoverable: z.boolean().default(false),
	excludedAddresses: addressList
});

const intIn = (limits: { min: number; max: number }) =>
	z.number().int().min(limits.min).max(limits.max);

const scheduleSchema = z.object({
	syncEveryMinutes: intIn(SCHEDULE_LIMITS.syncEveryMinutes),
	discoverEveryHours: intIn(SCHEDULE_LIMITS.discoverEveryHours),
	parallelMailboxes: intIn(SCHEDULE_LIMITS.parallelMailboxes),
	paused: z.boolean(),
	// Added after 0.1.1; a schedule saved earlier has neither.
	pausedReason: z.enum(['manual', 'disk']).nullable().default(null),
	pausedAt: z.string().nullable().default(null)
});

const diskSchema = z
	.object({
		warnPercent: z.number().int().min(50).max(98),
		pausePercent: z.number().int().min(51).max(99)
	})
	.refine((disk) => disk.warnPercent < disk.pausePercent, 'The warning must come before the pause');

const backupSchema = z.object({
	root: z
		.string()
		.refine((path) => isAbsolute(path), 'The backup folder must be a full path')
		.nullable()
});

const absolutePath = z.string().refine((path) => isAbsolute(path), 'Not a full path');

/** The backup folder's own id, also written in its marker file (storage/backup-marker.ts). */
const backupMarkerSchema = z.object({ id: z.uuid() }).nullable();

const backupMoveSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({
		kind: z.literal('moving'),
		from: absolutePath,
		to: absolutePath,
		startedAt: z.string(),
		actor: z.string()
	}),
	z.object({
		kind: z.literal('moved'),
		from: absolutePath,
		to: absolutePath,
		finishedAt: z.string(),
		files: z.number().int().nonnegative(),
		bytes: z.number().int().nonnegative(),
		problems: z.number().int().nonnegative()
	})
]);

const updatesSchema = z.object({ automatic: z.boolean() });

/** The update reminder's answer (domain/releases/update-reminder.ts). */
const updateReminderSchema = z.object({
	snoozedUntil: z.iso.datetime().nullable(),
	skippedVersion: z.string().max(40).nullable()
});

/** Remote access (docs/specs/SPEC-REMOTE.md): the HTTPS listener, who may reach it, accounts. */
const remoteSchema = z.object({
	enabled: z.boolean(),
	port: z.number().int().min(1024).max(65_535),
	/** Addresses and IPv4 ranges allowed to connect, one per entry (domain/remote.ts). */
	allowList: z.array(z.string().max(60)).max(50),
	/** The self-signed certificate, and its private key sealed with SECRETS_KEY. */
	certificatePem: z.string().max(10_000).nullable(),
	sealedKey: z.string().max(10_000).nullable(),
	accounts: z
		.array(
			z.object({
				username: z.string().max(40),
				/** scrypt$salt$hash (services/remote/accounts.ts). */
				passwordHash: z.string().max(200),
				disabled: z.boolean(),
				createdAt: z.iso.datetime(),
				lastSignInAt: z.iso.datetime().nullable()
			})
		)
		.max(20)
});
export type RemoteSettings = z.infer<typeof remoteSchema>;
export type RemoteAccount = RemoteSettings['accounts'][number];

/** A Mailgun sending domain: letters, digits, dots and hyphens (mg.example.com). */
const DOMAIN =
	/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const recipientSchema = z.object({
	id: z.string().min(1),
	name: z.string().trim().min(1, 'Give the person a name').max(100),
	email: z.string().trim().toLowerCase().pipe(z.email('That is not an email address')),
	enabled: z.boolean(),
	alerts: z.array(z.enum(ALERT_TYPES))
});

const emailSchema = z.object({
	mailgun: z
		.object({
			domain: z.string().regex(DOMAIN),
			from: z.string().min(1).max(200),
			region: z.enum(MAILGUN_REGIONS),
			sealedKey: z.string(),
			keyHint: z.string(),
			setAt: z.string()
		})
		.nullable(),
	recipients: z.array(recipientSchema).max(100)
});
type StoredEmail = z.infer<typeof emailSchema>;

/** What the throughput governor learned about Microsoft's limits, kept between restarts. */
const learnedPaceSchema = z
	.object({
		startsPerSecond: z.number().positive(),
		inFlightCap: z.number().int().positive(),
		ceiling: z
			.object({
				startsPerSecond: z.number().positive(),
				inFlightCap: z.number().int().positive(),
				at: z.number().int().nonnegative()
			})
			.nullable()
	})
	.nullable();

/**
 * Access for AI tools (the MCP endpoint, /mcp): off until turned on in Settings, and then only
 * with the access token, of which only the SHA-256 is kept.
 */
const aiAccessSchema = z.object({
	enabled: z.boolean(),
	tokenSha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.nullable(),
	tokenHint: z.string().max(12).nullable(),
	tokenCreatedAt: z.string().nullable()
});
export type AiAccess = z.infer<typeof aiAccessSchema>;

function emptyRemote(): RemoteSettings {
	return {
		enabled: false,
		port: 8443,
		allowList: [],
		certificatePem: null,
		sealedKey: null,
		accounts: []
	};
}

function emptyEmail(): StoredEmail {
	return { mailgun: null, recipients: [] };
}

const KEYS = {
	connection: { schema: connectionSchema, fallback: emptyConnection() },
	scope: { schema: scopeSchema, fallback: SCOPE_DEFAULTS },
	schedule: { schema: scheduleSchema, fallback: SCHEDULE_DEFAULTS },
	backup: { schema: backupSchema, fallback: { root: null } },
	backupMarker: { schema: backupMarkerSchema, fallback: null },
	backupMove: { schema: backupMoveSchema, fallback: { kind: 'none' } },
	updates: { schema: updatesSchema, fallback: UPDATE_DEFAULTS },
	updateReminder: {
		schema: updateReminderSchema,
		fallback: { snoozedUntil: null, skippedVersion: null }
	},
	remote: { schema: remoteSchema, fallback: emptyRemote() },
	disk: { schema: diskSchema, fallback: DISK_DEFAULTS },
	email: { schema: emailSchema, fallback: emptyEmail() },
	throughput: { schema: learnedPaceSchema, fallback: null },
	ai: {
		schema: aiAccessSchema,
		fallback: { enabled: false, tokenSha256: null, tokenHint: null, tokenCreatedAt: null }
	}
} as const;
type Key = keyof typeof KEYS;

export class SettingsError extends Error {
	override name = 'SettingsError';
}

function emptyConnection(): StoredConnection {
	return { tenantId: '', clientId: '', auth: { kind: 'none' } };
}

function read<T>(db: Queryable, key: Key, schema: z.ZodType<T>, fallback: T): T {
	const row = db.select().from(settings).where(eq(settings.key, key)).get();
	if (row === undefined) {
		return fallback;
	}
	const parsed = schema.safeParse(JSON.parse(row.value));
	if (!parsed.success) {
		// Fail loudly: a stored setting that no longer validates is a bug to fix, not to hide.
		throw new SettingsError(
			`The stored ${key} setting is not valid (${parsed.error.issues[0]?.message ?? 'invalid'}). Save it again on the Settings page.`
		);
	}
	return parsed.data;
}

function write(db: Queryable, key: Key, value: unknown, now = Date.now()): void {
	const text = JSON.stringify(value);
	db.insert(settings)
		.values({ key, value: text, updatedAt: new Date(now) })
		.onConflictDoUpdate({ target: settings.key, set: { value: text, updatedAt: new Date(now) } })
		.run();
}

export function readConnection(db: Queryable): StoredConnection {
	return read(db, 'connection', KEYS.connection.schema, KEYS.connection.fallback);
}
export function readScope(db: Queryable): ScopeSettings {
	return read(db, 'scope', KEYS.scope.schema, KEYS.scope.fallback);
}
export function readSchedule(db: Queryable): ScheduleSettings {
	return read(db, 'schedule', KEYS.schedule.schema, KEYS.schedule.fallback);
}
export function readBackup(db: Queryable): BackupSettings {
	return read(db, 'backup', KEYS.backup.schema, KEYS.backup.fallback);
}

export function readDisk(db: Queryable): DiskSettings {
	return read(db, 'disk', KEYS.disk.schema, KEYS.disk.fallback);
}

export function saveDisk(db: Queryable, disk: DiskSettings): void {
	const parsed = diskSchema.safeParse(disk);
	if (!parsed.success) {
		throw new SettingsError(parsed.error.issues[0]?.message ?? 'Those limits are not valid');
	}
	write(db, 'disk', parsed.data);
}

/** Pauses or resumes everything, recording who paused and when. */
export function savePause(
	db: Queryable,
	paused: boolean,
	reason: 'manual' | 'disk',
	now = Date.now()
): void {
	const schedule = readSchedule(db);
	write(db, 'schedule', {
		...schedule,
		paused,
		pausedReason: paused ? reason : null,
		pausedAt: paused ? new Date(now).toISOString() : null
	});
}

export function readUpdates(db: Queryable): UpdateSettings {
	return read(db, 'updates', KEYS.updates.schema, KEYS.updates.fallback);
}

export function readRemote(db: Queryable): RemoteSettings {
	return read(db, 'remote', KEYS.remote.schema, KEYS.remote.fallback);
}

export function saveRemote(db: Queryable, remote: RemoteSettings): void {
	write(db, 'remote', remoteSchema.parse(remote));
}

export function readAiAccess(db: Queryable): AiAccess {
	return read(db, 'ai', KEYS.ai.schema, KEYS.ai.fallback);
}

export function saveAiAccess(db: Queryable, access: AiAccess): void {
	write(db, 'ai', aiAccessSchema.parse(access));
}

export function readUpdateReminder(db: Queryable): UpdateReminderState {
	return read(db, 'updateReminder', KEYS.updateReminder.schema, KEYS.updateReminder.fallback);
}

export function saveUpdateReminder(db: Queryable, reminder: UpdateReminderState): void {
	write(db, 'updateReminder', updateReminderSchema.parse(reminder));
}

export function saveUpdates(db: Queryable, updates: UpdateSettings): void {
	write(db, 'updates', updatesSchema.parse(updates));
}

/** Validates and stores the tenant and app IDs, keeping the stored secret or certificate. */
export function saveConnectionIds(db: Queryable, tenantId: string, clientId: string): void {
	const current = readConnection(db);
	write(db, 'connection', connectionSchema.parse({ ...current, tenantId, clientId }));
}

export function saveClientSecret(
	db: Queryable,
	secret: string,
	key: Buffer,
	now = Date.now()
): void {
	const trimmed = secret.trim();
	if (trimmed.length < 16) {
		throw new SettingsError(
			'That is too short to be a client secret: paste its Value, not its ID.'
		);
	}
	const current = readConnection(db);
	write(db, 'connection', {
		...current,
		auth: {
			kind: 'secret',
			sealedSecret: sealSecret(Buffer.from(trimmed), key),
			hint: `${trimmed.slice(0, 3)}…`,
			setAt: new Date(now).toISOString()
		}
	});
}

export function saveCertificate(
	db: Queryable,
	certificatePem: string,
	privateKeyPem: string,
	key: Buffer
): void {
	const current = readConnection(db);
	write(db, 'connection', {
		...current,
		auth: {
			kind: 'certificate',
			certificatePem,
			sealedPrivateKey: sealSecret(Buffer.from(privateKeyPem), key)
		}
	});
}

export function saveScope(db: Queryable, scope: ScopeSettings): void {
	const parsed = scopeSchema.safeParse(scope);
	if (!parsed.success) {
		throw new SettingsError(parsed.error.issues[0]?.message ?? 'Those settings are not valid');
	}
	write(db, 'scope', {
		...parsed.data,
		selectedAddresses: [...new Set(parsed.data.selectedAddresses)].sort(),
		excludedAddresses: [...new Set(parsed.data.excludedAddresses)].sort()
	});
}

/** Adds or removes one address from the picked mailboxes (the `selected` mode's list). */
export function setPicked(db: Queryable, address: string, picked: boolean): void {
	const scope = readScope(db);
	const lower = address.toLowerCase();
	const rest = scope.selectedAddresses.filter((selected) => selected !== lower);
	saveScope(db, { ...scope, selectedAddresses: picked ? [...rest, lower] : rest });
}

export function saveSchedule(db: Queryable, schedule: ScheduleSettings): void {
	const parsed = scheduleSchema.safeParse(schedule);
	if (!parsed.success) {
		throw new SettingsError(parsed.error.issues[0]?.message ?? 'Those settings are not valid');
	}
	write(db, 'schedule', parsed.data);
}

export function saveBackup(db: Queryable, backup: BackupSettings): void {
	const parsed = backupSchema.safeParse(backup);
	if (!parsed.success) {
		throw new SettingsError(parsed.error.issues[0]?.message ?? 'That folder is not valid');
	}
	write(db, 'backup', parsed.data);
}

export function readBackupMarker(db: Queryable): { id: string } | null {
	return read(db, 'backupMarker', KEYS.backupMarker.schema, KEYS.backupMarker.fallback);
}

export function saveBackupMarker(db: Queryable, marker: { id: string }): void {
	write(db, 'backupMarker', backupMarkerSchema.parse(marker));
}

export function readBackupMove(db: Queryable): BackupMoveState {
	return read(db, 'backupMove', KEYS.backupMove.schema, KEYS.backupMove.fallback);
}

export function saveBackupMove(db: Queryable, state: BackupMoveState): void {
	write(db, 'backupMove', backupMoveSchema.parse(state));
}

/** Where backups go: the setting, or `mailboxes` in the data folder. */
export function effectiveBackupRoot(db: Queryable, dataDir: string): string {
	return readBackup(db).root ?? join(dataDir, 'mailboxes');
}

/** Sign-in details for Graph, or null with the reason when the connection is not set up. */
export function graphCredentials(
	db: Queryable,
	key: Buffer
): { credentials: GraphCredentials } | { missing: string } {
	const connection = readConnection(db);
	if (connection.tenantId === '' || connection.clientId === '') {
		return { missing: 'Enter the tenant ID and application (client) ID on the Settings page.' };
	}
	const { tenantId, clientId, auth } = connection;
	switch (auth.kind) {
		case 'none':
			return { missing: 'Create a certificate (or add a client secret) on the Settings page.' };
		case 'secret':
			return {
				credentials: {
					tenantId,
					clientId,
					auth: { kind: 'secret', secret: openSecret(auth.sealedSecret, key).toString() }
				}
			};
		case 'certificate':
			return {
				credentials: {
					tenantId,
					clientId,
					auth: {
						kind: 'certificate',
						certificatePem: auth.certificatePem,
						privateKeyPem: openSecret(auth.sealedPrivateKey, key).toString()
					}
				}
			};
	}
}

export function settingsView(db: Queryable, dataDir: string): SettingsView {
	const connection = readConnection(db);
	const backup = readBackup(db);
	return {
		connection: connectionView(connection),
		scope: readScope(db),
		schedule: readSchedule(db),
		backup: { ...backup, effectiveRoot: backup.root ?? join(dataDir, 'mailboxes') },
		updates: readUpdates(db),
		disk: readDisk(db)
	};
}

function connectionView(connection: StoredConnection): ConnectionView {
	const { tenantId, clientId, auth } = connection;
	switch (auth.kind) {
		case 'none':
			return { tenantId, clientId, auth: { kind: 'none' } };
		case 'secret':
			return { tenantId, clientId, auth: { kind: 'secret', hint: auth.hint, setAt: auth.setAt } };
		case 'certificate': {
			const facts = certificateFacts(auth.certificatePem);
			return {
				tenantId,
				clientId,
				auth: {
					kind: 'certificate',
					thumbprint: facts.thumbprint,
					validTo: facts.validTo,
					certificatePem: auth.certificatePem
				}
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Email alerts: the Mailgun setup and the people on the list
// ---------------------------------------------------------------------------

function readEmail(db: Queryable): StoredEmail {
	return read(db, 'email', KEYS.email.schema, KEYS.email.fallback);
}

/** What Lookstow needs to send through Mailgun, with the key opened, or null when not set up. */
export type MailgunSetup = { domain: string; from: string; region: MailgunRegion; apiKey: string };

export function mailgunSetup(db: Queryable, key: Buffer): MailgunSetup | null {
	const mailgun = readEmail(db).mailgun;
	if (mailgun === null) {
		return null;
	}
	return {
		domain: mailgun.domain,
		from: mailgun.from,
		region: mailgun.region,
		apiKey: openSecret(mailgun.sealedKey, key).toString()
	};
}

export function mailgunView(db: Queryable): MailgunView {
	const mailgun = readEmail(db).mailgun;
	return mailgun === null
		? { kind: 'none' }
		: {
				kind: 'set',
				domain: mailgun.domain,
				from: mailgun.from,
				region: mailgun.region,
				keyHint: mailgun.keyHint,
				setAt: mailgun.setAt
			};
}

/**
 * Saves the Mailgun setup. A blank key keeps the one stored (the page never shows it), so an
 * admin can change the domain or sender without pasting the key again.
 */
export function saveMailgun(
	db: Queryable,
	input: { domain: string; from: string; region: string; apiKey: string },
	key: Buffer,
	now = Date.now()
): void {
	const current = readEmail(db);
	const domain = input.domain.trim().toLowerCase();
	if (!DOMAIN.test(domain)) {
		throw new SettingsError('The sending domain is a domain name, such as mg.example.com.');
	}
	const region = MAILGUN_REGIONS.find((known) => known === input.region);
	if (region === undefined) {
		throw new SettingsError('Choose the US or EU region, as your Mailgun account shows it.');
	}
	const apiKey = input.apiKey.trim();
	let sealed: { sealedKey: string; keyHint: string; setAt: string };
	if (apiKey === '') {
		if (current.mailgun === null) {
			throw new SettingsError('Paste the Mailgun sending key.');
		}
		sealed = {
			sealedKey: current.mailgun.sealedKey,
			keyHint: current.mailgun.keyHint,
			setAt: current.mailgun.setAt
		};
	} else {
		if (apiKey.length < 20 || /\s/.test(apiKey)) {
			throw new SettingsError('That is not a Mailgun sending key: paste the whole key.');
		}
		sealed = {
			sealedKey: sealSecret(Buffer.from(apiKey), key),
			keyHint: `…${apiKey.slice(-4)}`,
			setAt: new Date(now).toISOString()
		};
	}
	const from = input.from.trim() === '' ? `Lookstow <lookstow@${domain}>` : input.from.trim();
	if (from.length > 200 || /[\r\n]/.test(from)) {
		throw new SettingsError('The sender is one line, such as Lookstow <lookstow@mg.example.com>.');
	}
	write(db, 'email', { ...current, mailgun: { domain, from, region, ...sealed } }, now);
}

export function clearMailgun(db: Queryable, now = Date.now()): void {
	write(db, 'email', { ...readEmail(db), mailgun: null }, now);
}

export function readRecipients(db: Queryable): AlertRecipient[] {
	return readEmail(db).recipients;
}

/** Saves the whole list after checking each person; an invalid entry refuses the save. */
export function saveRecipients(
	db: Queryable,
	recipients: readonly AlertRecipient[],
	now = Date.now()
): void {
	const parsed = z.array(recipientSchema).max(100).safeParse(recipients);
	if (!parsed.success) {
		throw new SettingsError(parsed.error.issues[0]?.message ?? 'That list is not valid.');
	}
	const addresses = parsed.data.map((recipient) => recipient.email);
	if (new Set(addresses).size !== addresses.length) {
		throw new SettingsError('Each email address can be on the list once.');
	}
	write(db, 'email', { ...readEmail(db), recipients: parsed.data }, now);
}

// ---------------------------------------------------------------------------
// Throughput: what the governor learned, so a restart resumes just under Microsoft's limit
// ---------------------------------------------------------------------------

export type StoredPace = z.infer<typeof learnedPaceSchema>;

export function readLearnedPace(db: Queryable): StoredPace {
	return read(db, 'throughput', KEYS.throughput.schema, KEYS.throughput.fallback);
}

export function saveLearnedPace(db: Queryable, pace: StoredPace, now = Date.now()): void {
	write(db, 'throughput', pace, now);
}
