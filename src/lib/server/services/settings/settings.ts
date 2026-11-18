import { eq } from 'drizzle-orm';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { Queryable } from '../../database/connection.ts';
import { settings } from '../../database/schema.ts';
import { certificateFacts } from '../../crypto/app-certificate.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import type { GraphCredentials } from '../graph/token.ts';
import {
	SCHEDULE_DEFAULTS,
	SCHEDULE_LIMITS,
	SCOPE_DEFAULTS,
	UPDATE_DEFAULTS,
	type BackupSettings,
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
	excludedAddresses: addressList
});

const intIn = (limits: { min: number; max: number }) =>
	z.number().int().min(limits.min).max(limits.max);

const scheduleSchema = z.object({
	syncEveryMinutes: intIn(SCHEDULE_LIMITS.syncEveryMinutes),
	discoverEveryHours: intIn(SCHEDULE_LIMITS.discoverEveryHours),
	parallelMailboxes: intIn(SCHEDULE_LIMITS.parallelMailboxes),
	paused: z.boolean()
});

const backupSchema = z.object({
	root: z
		.string()
		.refine((path) => isAbsolute(path), 'The backup folder must be a full path')
		.nullable()
});

const updatesSchema = z.object({ automatic: z.boolean() });

const KEYS = {
	connection: { schema: connectionSchema, fallback: emptyConnection() },
	scope: { schema: scopeSchema, fallback: SCOPE_DEFAULTS },
	schedule: { schema: scheduleSchema, fallback: SCHEDULE_DEFAULTS },
	backup: { schema: backupSchema, fallback: { root: null } },
	updates: { schema: updatesSchema, fallback: UPDATE_DEFAULTS }
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

export function readUpdates(db: Queryable): UpdateSettings {
	return read(db, 'updates', KEYS.updates.schema, KEYS.updates.fallback);
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
		updates: readUpdates(db)
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
