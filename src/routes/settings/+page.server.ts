import type { Actions, PageServerLoad } from './$types';
import { checked, done, field, refused } from '#lib/server/actions.ts';
import { makeAppCertificate } from '#lib/server/crypto/app-certificate.ts';
import { env } from '#lib/server/env.ts';
import { backupEngine, database, dataDir } from '#lib/server/runtime.ts';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import { testConnection } from '#lib/server/services/graph/connection-test.ts';
import {
	graphCredentials,
	readSchedule,
	saveBackup,
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
		return attempt(() => {
			const mode = field(data, 'mode') === 'selected' ? 'selected' : 'all';
			const selectedAddresses = addresses(field(data, 'selected'));
			saveScope(database, {
				mode,
				selectedAddresses,
				includeShared: checked(data, 'includeShared'),
				includeResources: checked(data, 'includeResources'),
				includeArchives: checked(data, 'includeArchives'),
				excludedAddresses: addresses(field(data, 'excluded'))
			});
			backupEngine().requestSync(null, 'scope changed');
			return saved(
				mode === 'selected'
					? `Backups were limited to ${selectedAddresses.length} chosen mailbox${selectedAddresses.length === 1 ? '' : 'es'}`
					: 'What is backed up was changed',
				mode === 'selected' && selectedAddresses.length === 0
					? 'Saved. No mailbox is picked yet, so nothing is backed up: pick some on the Mailboxes page.'
					: 'Saved. A sync with the new choice has started.'
			);
		});
	},
	schedule: async ({ request }) => {
		const data = await request.formData();
		return attempt(() => {
			saveSchedule(database, {
				syncEveryMinutes: whole(data, 'syncEveryMinutes'),
				discoverEveryHours: whole(data, 'discoverEveryHours'),
				parallelMailboxes: whole(data, 'parallelMailboxes'),
				paused: readSchedule(database).paused
			});
			return saved('The schedule was changed', 'Saved the schedule.');
		});
	},
	pause: () =>
		attempt(() => {
			const schedule = readSchedule(database);
			saveSchedule(database, { ...schedule, paused: !schedule.paused });
			return saved(
				schedule.paused ? 'The schedule was resumed' : 'The schedule was paused',
				schedule.paused ? 'Resumed.' : 'Paused: nothing runs on the schedule until you resume.'
			);
		}),
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
