import { asRecord, GraphClient, GraphError, stringField } from './client.ts';
import { isNoMailbox } from './discovery.ts';
import { sharedGovernor } from './governor.ts';
import { TokenSource, type FetchLike, type GraphCredentials } from './token.ts';

/**
 * Test connection on the Settings page: sign in, list users, then read one mailbox's settings and
 * folders. Each step says what it proved, so a failure names the missing piece (consent, a
 * permission, the certificate) instead of a bare error.
 *
 * Users whose mailbox can't be read (never had one, inactive, soft-deleted, on-premises) are
 * skipped, as discovery skips them: the test tries the next one, up to SAMPLE users.
 */
export type TestStep = { name: string; ok: boolean; detail: string };

const SAMPLE = 25;

export async function testConnection(
	credentials: GraphCredentials,
	fetchImpl: FetchLike = fetch
): Promise<TestStep[]> {
	const steps: TestStep[] = [];
	const tokens = new TokenSource(credentials, fetchImpl);
	let roles: string[] | null;
	try {
		roles = grantedRoles(await tokens.accessToken());
		steps.push({ name: 'Sign in to Microsoft Entra', ok: true, detail: 'Signed in as the app.' });
	} catch (error) {
		steps.push({ name: 'Sign in to Microsoft Entra', ok: false, detail: message(error) });
		return steps;
	}
	if (roles !== null) {
		const missing = ARCHIVE_PERMISSIONS.filter((permission) => !roles.includes(permission));
		steps.push({
			name: 'Online archive permissions',
			ok: missing.length === 0,
			detail:
				missing.length === 0
					? `Granted: ${ARCHIVE_PERMISSIONS.join(', ')}.`
					: `Not granted yet: ${missing.join(', ')}. Add them as Microsoft Graph application permissions and grant admin consent; until then archives cannot be copied. The app has: ${roles.length === 0 ? 'no application permissions' : [...roles].sort().join(', ')}.`
		});
	}
	const client = new GraphClient(tokens, { governor: sharedGovernor(), fetch: fetchImpl });
	let candidates: { id: string; mail: string }[];
	try {
		const page = asRecord(await client.getJson(`/v1.0/users?$select=id,mail&$top=${SAMPLE}`));
		const users = Array.isArray(page['value']) ? page['value'].map(asRecord) : [];
		candidates = users.flatMap((user) => {
			const id = stringField(user, 'id');
			const mail = stringField(user, 'mail');
			return id !== null && mail !== null && mail !== '' ? [{ id, mail }] : [];
		});
		steps.push({
			name: 'List users (User.Read.All)',
			ok: true,
			detail: `Read ${users.length} users.`
		});
	} catch (error) {
		steps.push({
			name: 'List users (User.Read.All)',
			ok: false,
			detail: permissionHint(error, 'User.Read.All')
		});
		return steps;
	}

	let mailbox: { id: string; mail: string } | null = null;
	let skipped = 0;
	for (const candidate of candidates) {
		try {
			await client.getJson(
				`/v1.0/users/${encodeURIComponent(candidate.id)}/mailboxSettings?$select=userPurpose`
			);
			mailbox = candidate;
			break;
		} catch (error) {
			if (isNoMailbox(error)) {
				skipped += 1;
				continue;
			}
			steps.push({
				name: 'Read mailbox settings (MailboxSettings.Read)',
				ok: false,
				detail: permissionHint(error, 'MailboxSettings.Read')
			});
			return steps;
		}
	}
	if (mailbox === null) {
		steps.push({
			name: 'Read mailbox settings (MailboxSettings.Read)',
			ok: false,
			detail: `None of the first ${candidates.length} users with a mail address has an Exchange Online mailbox Lookstow can read (inactive, soft-deleted or on-premises). Discovery skips such users; check that the tenant has licensed mailboxes.`
		});
		return steps;
	}
	const skippedNote =
		skipped === 0 ? '' : ` (${skipped} user${skipped === 1 ? '' : 's'} without a mailbox skipped)`;
	steps.push({
		name: 'Read mailbox settings (MailboxSettings.Read)',
		ok: true,
		detail: `Allowed, on ${mailbox.mail}${skippedNote}.`
	});
	try {
		await client.getJson(
			`/v1.0/users/${encodeURIComponent(mailbox.id)}/mailFolders?$top=1&$select=id`
		);
		steps.push({ name: 'Read mail (Mail.Read)', ok: true, detail: `Allowed, on ${mailbox.mail}.` });
	} catch (error) {
		steps.push({
			name: 'Read mail (Mail.Read)',
			ok: false,
			detail: permissionHint(error, 'Mail.Read')
		});
	}
	return steps;
}

const ARCHIVE_PERMISSIONS = [
	'MailboxFolder.Read.All',
	'MailboxItem.Read.All',
	'MailboxItem.Export.All'
] as const;

/**
 * The application permissions Entra put in the access token (its `roles` claim): exactly what
 * Microsoft will allow, after consent. Null when the token cannot be read (it is opaque to
 * apps by contract, though Graph tokens are JWTs today).
 */
export function grantedRoles(accessToken: string): string[] | null {
	const payload = accessToken.split('.')[1];
	if (payload === undefined) {
		return null;
	}
	try {
		const claims = asRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
		const roles = claims['roles'];
		return Array.isArray(roles) ? roles.filter((role) => typeof role === 'string') : [];
	} catch {
		return null;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function permissionHint(error: unknown, permission: string): string {
	if (error instanceof GraphError && (error.status === 401 || error.status === 403)) {
		return `Refused (${error.code}). Add the application permission ${permission} and grant admin consent, or check the Exchange RBAC scope.`;
	}
	return message(error);
}
