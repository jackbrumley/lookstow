import { asRecord, GraphError, stringField, type GraphClient } from './client.ts';

/**
 * Finds every mailbox in the tenant: each Entra user that has an Exchange Online mailbox
 * (people, shared mailboxes, rooms and equipment are all users in Entra), and each online
 * archive. Exchange's own purpose for the mailbox comes from `mailboxSettings.userPurpose`
 * (Graph v1.0); archives come from the beta `settings/exchange` resource.
 */
export type DiscoveredMailbox = {
	userId: string;
	/** user, shared, room, equipment, linked, others, or archive. */
	kind: string;
	address: string;
	displayName: string;
	/** Only for archives: Exchange's id for the archive mailbox. */
	exchangeMailboxId: string | null;
};

export type DiscoveryResult = {
	mailboxes: DiscoveredMailbox[];
	/** Users checked: every enabled or disabled user with a mail address. */
	usersChecked: number;
	/** Problems that did not stop discovery (one user's settings unreadable, archives unknown). */
	warnings: string[];
};

/** Users are checked a few at a time: different mailboxes, so Graph's per-mailbox limit holds. */
const USER_CONCURRENCY = 8;

const NO_MAILBOX_CODES = new Set([
	'MailboxNotEnabledForRESTAPI',
	'MailboxNotHostedInExchangeOnline',
	'ResourceNotFound',
	'ErrorItemNotFound',
	'ErrorNonExistentMailbox',
	'ErrorInvalidUser'
]);

/**
 * Graph's answer for a user with no Exchange Online mailbox to read: never had one, inactive,
 * soft-deleted, or still on-premises ("The mailbox is either inactive, soft-deleted, or is
 * hosted on-premise"). Not a permission problem: such users are skipped.
 */
export function isNoMailbox(error: unknown): boolean {
	return error instanceof GraphError && (error.status === 404 || NO_MAILBOX_CODES.has(error.code));
}

export type DiscoveryProgress = { usersTotal: number | null; usersChecked: number; found: number };

export async function discoverMailboxes(
	client: GraphClient,
	options: { includeArchives: boolean; progress?: (progress: DiscoveryProgress) => void }
): Promise<DiscoveryResult> {
	const report = options.progress ?? (() => undefined);
	const users: { id: string; address: string; displayName: string }[] = [];
	for await (const page of client.pages(
		'/v1.0/users?$select=id,displayName,mail,userPrincipalName&$top=999'
	)) {
		for (const item of page.items) {
			const user = asRecord(item);
			const id = stringField(user, 'id');
			const mail = stringField(user, 'mail');
			// No mail address means no Exchange mailbox (guests and cloud-only service accounts).
			if (id !== null && mail !== null && mail !== '') {
				users.push({
					id,
					address: mail.toLowerCase(),
					displayName: stringField(user, 'displayName') ?? mail
				});
			}
		}
	}

	const mailboxes: DiscoveredMailbox[] = [];
	const warnings: string[] = [];
	let checked = 0;
	report({ usersTotal: users.length, usersChecked: 0, found: 0 });
	// Several users are checked at once, so this changes between awaits; read it through a call.
	let archivesRefused = false;
	const archiveLookupBroken = (): boolean => archivesRefused;
	await forEachLimited(users, USER_CONCURRENCY, async (user) => {
		await checkUser(user);
		checked += 1;
		report({ usersTotal: users.length, usersChecked: checked, found: mailboxes.length });
	});
	mailboxes.sort((a, b) => a.address.localeCompare(b.address) || a.kind.localeCompare(b.kind));
	return { mailboxes, usersChecked: users.length, warnings };

	async function checkUser(user: {
		id: string;
		address: string;
		displayName: string;
	}): Promise<void> {
		const purpose = await mailboxPurpose(client, user.id).catch((error: unknown) => {
			warnings.push(`${user.address}: could not read its mailbox settings (${describe(error)})`);
			return null;
		});
		if (purpose === null || purpose === 'none') {
			return;
		}
		mailboxes.push({
			userId: user.id,
			kind: purpose,
			address: user.address,
			displayName: user.displayName,
			exchangeMailboxId: null
		});
		if (!options.includeArchives || archiveLookupBroken()) {
			return;
		}
		try {
			const archiveId = await archiveMailboxId(client, user.id);
			if (archiveId !== null) {
				mailboxes.push({
					userId: user.id,
					kind: 'archive',
					address: user.address,
					displayName: `${user.displayName} (archive)`,
					exchangeMailboxId: archiveId
				});
			}
		} catch (error) {
			// One refusal means the permission or the beta API is missing for every user:
			// say so once and stop asking.
			if (error instanceof GraphError && (error.status === 403 || error.status === 401)) {
				// Several users are checked at once, so more than one refusal can arrive.
				if (archiveLookupBroken()) {
					return;
				}
				archivesRefused = true;
				warnings.push(
					`Online archives could not be listed: ${describe(error)}. Check the app registration's permissions.`
				);
			} else {
				warnings.push(`${user.address}: could not check for an archive (${describe(error)})`);
			}
		}
	}
}

/** Exchange's purpose for the user's mailbox, or `none` when the user has no mailbox. */
async function mailboxPurpose(client: GraphClient, userId: string): Promise<string> {
	try {
		const settings = asRecord(
			await client.getJson(
				`/v1.0/users/${encodeURIComponent(userId)}/mailboxSettings?$select=userPurpose`
			)
		);
		return stringField(settings, 'userPurpose') ?? 'user';
	} catch (error) {
		if (isNoMailbox(error)) {
			return 'none';
		}
		throw error;
	}
}

/**
 * The archive mailbox's Exchange id, or null when the user has no online archive.
 * Graph beta `exchangeSettings`; checked against a real tenant before archives are synced
 * (docs/TODO.md).
 */
async function archiveMailboxId(client: GraphClient, userId: string): Promise<string | null> {
	try {
		const settings = asRecord(
			await client.getJson(`/beta/users/${encodeURIComponent(userId)}/settings/exchange`)
		);
		const archiveId = stringField(settings, 'inPlaceArchiveMailboxId');
		return archiveId === null || archiveId === '' ? null : archiveId;
	} catch (error) {
		if (isNoMailbox(error)) {
			return null;
		}
		throw error;
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Runs `work` over `items`, at most `limit` at a time. */
export async function forEachLimited<T>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	// The first failure: once set, no new work starts, and work already running finishes before
	// the error is passed on, so nothing is left running unwatched.
	const state: { failed: { error: unknown } | null } = { failed: null };
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (state.failed === null && next < items.length) {
			const item = items[next];
			next += 1;
			if (item !== undefined) {
				try {
					await work(item);
				} catch (error) {
					state.failed ??= { error };
				}
			}
		}
	});
	await Promise.all(workers);
	if (state.failed !== null) {
		throw state.failed.error;
	}
}
