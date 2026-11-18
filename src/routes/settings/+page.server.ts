import type { Actions, PageServerLoad } from './$types';
import { checked, done, field, refused } from '#lib/server/actions.ts';
import { makeAppCertificate } from '#lib/server/crypto/app-certificate.ts';
import { env } from '#lib/server/env.ts';
import { backupEngine, database, dataDir } from '#lib/server/runtime.ts';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import { testConnection } from '#lib/server/services/graph/connection-test.ts';
import { inScope } from '#lib/server/services/engine/scope.ts';
import { deleteMailboxBackup } from '#lib/server/services/mailboxes/delete-backup.ts';
import { allMailboxes } from '#lib/server/services/mailboxes/repository.ts';
import { plural } from '#lib/utils/format.ts';
import {
	effectiveBackupRoot,
	graphCredentials,
	readSchedule,
	readScope,
	saveBackup,
	saveDisk,
	saveCertificate,
	saveClientSecret,
	saveConnectionIds,
	saveSchedule,
	saveScope,
	saveUpdates,
	settingsView
} from '#lib/server/services/settings/settings.ts';
import { hostname } from 'node:os';

/** Settings: the Microsoft 365 connection, what is backed up, when, and where. */
export const load = (() => ({
	settings: settingsView(database, dataDir())
})) satisfies PageServerLoad;

function saved(summary: string, message: string) {
	recordActivity(database, { level: 'info', kind: 'settings', actor: 'console', summary });
	return done(message);
}

function attempt(work: () => ReturnType<typeof done>) {
	try {
		return work();
	} catch (error) {
		return refused(error instanceof Error ? error.message : String(error));
	}
}

/** Addresses typed one per line (or separated by commas or spaces), lower case. */
function addresses(text: string): string[] {
	return text
		.split(/[\s,;]+/)
		.map((address) => address.trim().toLowerCase())
		.filter((address) => address !== '');
}

function whole(data: FormData, name: string): number {
	return Number.parseInt(field(data, name), 10);
}

export const actions = {
	connection: async ({ request }) => {
		const data = await request.formData();
		return attempt(() => {
			saveConnectionIds(
				database,
				field(data, 'tenantId').toLowerCase(),
				field(data, 'clientId').toLowerCase()
			);
			return saved(
				'The Microsoft 365 tenant and app IDs were changed',
				'Saved the tenant and application IDs.'
			);
		});
	},
	certificate: () =>
		attempt(() => {
			const certificate = makeAppCertificate(`Lookstow on ${hostname()}`, Date.now());
			saveCertificate(
				database,
				certificate.certificatePem,
				certificate.privateKeyPem,
				env.secretsKey
			);
			return saved(
				'A new sign-in certificate was created',
				'Created a new certificate. Download it and upload it to the app registration.'
			);
		}),
	secret: async ({ request }) => {
		const data = await request.formData();
		return attempt(() => {
			saveClientSecret(database, field(data, 'secret'), env.secretsKey);
			return saved('A client secret was saved', 'Saved the client secret.');
		});
	},
	test: async () => {
		const found = graphCredentials(database, env.secretsKey);
		if ('missing' in found) {
			return refused(found.missing);
		}
		const steps = await testConnection(found.credentials);
		const failed = steps.find((step) => !step.ok);
		if (failed === undefined) {
			backupEngine().requestDiscovery();
			return done(`Connected: ${steps.map((step) => step.name).join(', ')}. Discovery starts now.`);
		}
		return refused(`${failed.name}: ${failed.detail}`);
	},
	scope: async ({ request }) => {
		const data = await request.formData();
		const previous = readScope(database);
		const before = new Set(
			allMailboxes(database)
				.filter((row) => inScope(row, previous))
				.map((row) => row.id)
		);
		const mode = field(data, 'mode') === 'selected' ? 'selected' : 'all';
		const selectedAddresses = addresses(field(data, 'selected'));
		try {
			saveScope(database, {
				mode,
				selectedAddresses,
				includeShared: checked(data, 'includeShared'),
				includeResources: checked(data, 'includeResources'),
				includeArchives: checked(data, 'includeArchives'),
				excludedAddresses: addresses(field(data, 'excluded'))
			});
		} catch (error) {
			return refused(error instanceof Error ? error.message : String(error));
		}
		const scope = readScope(database);
		const rows = allMailboxes(database);
		const leaving = rows.filter((row) => before.has(row.id) && !inScope(row, scope));
		const joining = rows.filter((row) => !before.has(row.id) && inScope(row, scope));
		const engine = backupEngine();
		for (const row of leaving) {
			engine.cancel(row.id);
		}
		const withBackup = leaving.filter((row) => row.itemCount > 0);
		let deleted = 0;
		if (field(data, 'existing') === 'delete' && withBackup.length > 0) {
			if (field(data, 'confirm') !== 'DELETE') {
				saveScope(database, previous);
				return refused('Type DELETE to confirm deleting their backups. Nothing was changed.');
			}
			const backupRoot = effectiveBackupRoot(database, dataDir());
			for (const row of withBackup) {
				await engine.waitUntilIdle(row.id);
				await deleteMailboxBackup(database, row, backupRoot, 'console');
				deleted += 1;
			}
		}
		engine.requestSync(joining.map((row) => row.id));
		const summary = [
			`${plural(joining.length, 'mailbox', 'mailboxes')} start being backed up`,
			`${plural(leaving.length, 'mailbox', 'mailboxes')} stop`,
			deleted > 0
				? `${plural(deleted, 'backup')} deleted`
				: withBackup.length > 0
					? `${plural(withBackup.length, 'backup')} kept`
					: null
		]
			.filter((part) => part !== null)
			.join(', ');
		return saved(
			`What is backed up was changed: ${summary}`,
			mode === 'selected' && selectedAddresses.length === 0
				? `Saved: ${summary}. No mailbox is picked yet: pick some on the Mailboxes page.`
				: `Saved: ${summary}.`
		);
	},
	schedule: async ({ request }) => {
		const data = await request.formData();
		return attempt(() => {
			saveSchedule(database, {
				...readSchedule(database),
				syncEveryMinutes: whole(data, 'syncEveryMinutes'),
				discoverEveryHours: whole(data, 'discoverEveryHours'),
				parallelMailboxes: whole(data, 'parallelMailboxes')
			});
			return saved('The schedule was changed', 'Saved the schedule.');
		});
	},
	disk: async ({ request }) => {
		const data = await request.formData();
		return attempt(() => {
			saveDisk(database, {
				warnPercent: whole(data, 'warnPercent'),
				pausePercent: whole(data, 'pausePercent')
			});
			return saved('The disk space limits were changed', 'Saved the disk space limits.');
		});
	},
	updates: async ({ request }) => {
		const data = await request.formData();
		const automatic = checked(data, 'automatic');
		return attempt(() => {
			saveUpdates(database, { automatic });
			return saved(
				automatic ? 'Automatic updates were turned on' : 'Automatic updates were turned off',
				automatic
					? 'Lookstow installs new releases by itself.'
					: 'Lookstow only updates when someone chooses Update now.'
			);
		});
	},
	backup: async ({ request }) => {
		const data = await request.formData();
		const root = field(data, 'root');
		return attempt(() => {
			saveBackup(database, { root: root === '' ? null : root });
			return saved(
				`The backup folder was changed to ${root === '' ? 'the default' : root}`,
				'Saved. Move everything from the old folder into the new one: Lookstow finds stored messages by their place under the backup folder.'
			);
		});
	}
} satisfies Actions;
