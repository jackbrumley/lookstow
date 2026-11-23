import type { Actions, PageServerLoad } from './$types';
import { checked, done, field, refused } from '#lib/server/actions.ts';
import { makeAppCertificate } from '#lib/server/crypto/app-certificate.ts';
import { env } from '#lib/server/env.ts';
import { backupEngine, database, dataDir } from '#lib/server/runtime.ts';
import { recordActivity } from '#lib/server/services/activity/activity.ts';
import { testConnection } from '#lib/server/services/graph/connection-test.ts';
import {
	backupsOutsideScope,
	changeScope,
	describeScopeChange
} from '#lib/server/services/engine/scope-change.ts';
import {
	effectiveBackupRoot,
	graphCredentials,
	readAiAccess,
	readSchedule,
	saveBackup,
	saveDisk,
	saveCertificate,
	saveClientSecret,
	saveConnectionIds,
	saveSchedule,
	saveUpdates,
	settingsView
} from '#lib/server/services/settings/settings.ts';
import { snapshotSummary } from '#lib/server/services/storage/index-snapshot.ts';
import { storedTotals } from '#lib/server/services/mailboxes/repository.ts';
import { newAiToken, setAiEnabled } from '#lib/server/services/ai/access.ts';
import { hostname } from 'node:os';
import { indexingText } from '#lib/domain/indexing.ts';
import {
	addAccount,
	deleteAccount,
	readAllowList,
	remoteView,
	renewCertificate,
	resetPassword,
	saveRemoteAccess,
	setAccountDisabled,
	setAccountEvidencePacks,
	setAccountAiTools,
	newAccountAiToken,
	generatePassword
} from '#lib/server/services/remote/manage.ts';

/** Settings: the Microsoft 365 connection, what is backed up, when, and where. */
export const load = (async () => ({
	settings: settingsView(database, dataDir()),
	backupsOutsideScope: backupsOutsideScope(database),
	indexSnapshots: snapshotSummary(effectiveBackupRoot(database, dataDir()), dataDir()),
	learnedPace: backupEngine().learnedPace(),
	storedFiles: storedTotals(database).files,
	ai: aiView(),
	// The AI tools' content index (docs/specs/SPEC-SCALE.md): how far it has got, and any long
	// work after an update, so empty AI results are explained here.
	contentIndex: backupEngine().snapshot().contentIndex,
	indexing: indexingText(backupEngine().indexing()),
	// Remote access (docs/specs/SPEC-REMOTE.md): the listener, who may connect, accounts, audit.
	remote: await remoteView(database, dataDir())
})) satisfies PageServerLoad;

function aiView() {
	const access = readAiAccess(database);
	return {
		enabled: access.enabled,
		tokenHint: access.tokenHint,
		tokenCreatedAt: access.tokenCreatedAt
	};
}

function saved(summary: string, message: string) {
	recordActivity(database, { level: 'info', kind: 'settings', actor: 'console', summary });
	return done(message);
}

function attempt<T extends ReturnType<typeof done>>(work: () => T) {
	try {
		return work();
	} catch (error) {
		return refused(error instanceof Error ? error.message : String(error));
	}
}

/** attempt, for work the work thread answers. */
async function attemptAsync<T extends ReturnType<typeof done>>(work: () => Promise<T>) {
	try {
		return await work();
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

/** A password field as typed: spaces count, so it is not trimmed. */
function secret(data: FormData, name: string): string {
	const value = data.get(name);
	return typeof value === 'string' ? value : '';
}

/** The password for a remote account: one Lookstow makes (the default), or the one typed. */
function chosenPassword(data: FormData): { password: string; confirm: string; made: boolean } {
	if (checked(data, 'generate')) {
		const password = generatePassword();
		return { password, confirm: password, made: true };
	}
	return { password: secret(data, 'password'), confirm: secret(data, 'confirm'), made: false };
}

/**
 * A remote account's sign-in details, shown once to copy and send: a made password is in it (it
 * is kept only as a hash, so this is the only time it can be shown); a typed one is not.
 */
function withCredentials(message: string, username: string, password: string, made: boolean) {
	return { ...done(message), credentials: { username, password: made ? password : null } };
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
		const lockdown = backupEngine().lockdown();
		if (lockdown !== null) return refused(lockdown);
		const mode = field(data, 'mode') === 'selected' ? 'selected' : 'all';
		const selectedAddresses = addresses(field(data, 'selected'));
		const change = await changeScope(
			database,
			backupEngine(),
			effectiveBackupRoot(database, dataDir()),
			{
				mode,
				selectedAddresses,
				includeShared: checked(data, 'includeShared'),
				includeResources: checked(data, 'includeResources'),
				includeArchives: checked(data, 'includeArchives'),
				includeRecoverable: checked(data, 'includeRecoverable'),
				excludedAddresses: addresses(field(data, 'excluded'))
			},
			field(data, 'existing') === 'delete'
				? { kind: 'delete', confirmation: field(data, 'confirm') }
				: { kind: 'keep' }
		);
		if (change.kind === 'refused') {
			return refused(change.reason);
		}
		const summary = describeScopeChange(change);
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
	aiEnabled: async ({ request }) => {
		const enabled = checked(await request.formData(), 'enabled');
		return attempt(() => {
			setAiEnabled(database, enabled);
			return saved(
				enabled ? 'AI tools were turned on' : 'AI tools were turned off',
				enabled
					? 'AI tools are on: an agent on this computer with the access token can read the backup.'
					: 'AI tools are off: /mcp refuses every request.'
			);
		});
	},
	aiToken: () => {
		try {
			const token = newAiToken(database);
			recordActivity(database, {
				level: 'info',
				kind: 'settings',
				actor: 'console',
				summary: 'A new AI tools access token was created'
			});
			return {
				ok: true,
				message: 'Created a new access token. Copy it now: it is not shown again.',
				token
			};
		} catch (error) {
			return refused(error instanceof Error ? error.message : String(error));
		}
	},
	forgetPace: () =>
		attemptAsync(async () => {
			await backupEngine().forgetPace();
			return saved(
				'The learned speed was forgotten',
				'Lookstow starts again from the first-run pace and finds Microsoft’s limit again.'
			);
		}),
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
			// Once mail is stored, only Move may change the folder: it copies and checks every file.
			if (storedTotals(database).files > 0 || backupEngine().status().backupMove.kind !== 'none') {
				throw new Error(
					'Mail is already stored in the backup folder: use Move to take it to another folder.'
				);
			}
			saveBackup(database, { root: root === '' ? null : root });
			return saved(
				`The backup folder was changed to ${root === '' ? 'the default' : root}`,
				'Saved. New mail is stored in the new folder.'
			);
		});
	},
	move: async ({ request }) => {
		const data = await request.formData();
		const to = field(data, 'to').trim();
		try {
			await backupEngine().startMove(to, 'console');
		} catch (error) {
			return refused(error instanceof Error ? error.message : String(error));
		}
		return done('The move has started. Backups stop until every file is copied and checked.');
	},
	cancelMove: () =>
		attemptAsync(async () => {
			await backupEngine().cancelMove('console');
			return done('The move was stopped. The backup stays where it was.');
		}),
	removeOld: async ({ request }) => {
		const data = await request.formData();
		if (field(data, 'confirm').trim() !== 'REMOVE') {
			return refused('Type REMOVE to confirm removing the old copy.');
		}
		return attemptAsync(async () => {
			await backupEngine().removeOldCopy('console');
			return done('Removing the old copy. Files whose copy is not identical are kept.');
		});
	},
	remoteAccess: async ({ request }) => {
		const data = await request.formData();
		return attemptAsync(async () =>
			done(
				await saveRemoteAccess(database, env.secretsKey, {
					enabled: checked(data, 'enabled'),
					port: whole(data, 'port'),
					allowList: readAllowList(field(data, 'allowList'))
				})
			)
		);
	},
	remoteCertificate: () =>
		attemptAsync(async () => done(await renewCertificate(database, env.secretsKey))),
	remoteAdd: async ({ request }) => {
		const data = await request.formData();
		const username = field(data, 'username');
		const { password, confirm, made } = chosenPassword(data);
		return attemptAsync(async () =>
			withCredentials(
				await addAccount(database, username, password, confirm),
				username,
				password,
				made
			)
		);
	},
	remoteDisable: async ({ request }) => {
		const data = await request.formData();
		return attempt(() =>
			done(setAccountDisabled(database, field(data, 'username'), checked(data, 'disabled')))
		);
	},
	remotePassword: async ({ request }) => {
		const data = await request.formData();
		const username = field(data, 'username');
		const { password, confirm, made } = chosenPassword(data);
		return attemptAsync(async () =>
			withCredentials(
				await resetPassword(database, username, password, confirm),
				username,
				password,
				made
			)
		);
	},
	remoteEvidence: async ({ request }) => {
		const data = await request.formData();
		return attempt(() =>
			done(setAccountEvidencePacks(database, field(data, 'username'), checked(data, 'allowed')))
		);
	},
	remoteAi: async ({ request }) => {
		const data = await request.formData();
		const username = field(data, 'username');
		return attempt(() => {
			const changed = setAccountAiTools(database, username, checked(data, 'allowed'));
			return { ...done(changed.message), aiSetup: { username, token: changed.token } };
		});
	},
	remoteAiToken: async ({ request }) => {
		const data = await request.formData();
		const username = field(data, 'username');
		return attempt(() => {
			const made = newAccountAiToken(database, username);
			return { ...done(made.message), aiSetup: { username, token: made.token } };
		});
	},
	remoteDelete: async ({ request }) => {
		const data = await request.formData();
		return attempt(() => done(deleteAccount(database, field(data, 'username'))));
	}
} satisfies Actions;
