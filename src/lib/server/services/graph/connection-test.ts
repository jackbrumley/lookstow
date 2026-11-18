import { asRecord, GraphClient, GraphError, stringField } from './client.ts';
import { TokenSource, type FetchLike, type GraphCredentials } from './token.ts';

/**
 * Test connection on the Settings page: sign in, list one user, read one mailbox's settings.
 * Each step says what it proved, so a failure names the missing piece (consent, a permission,
 * the certificate) instead of a bare error.
 */
export type TestStep = { name: string; ok: boolean; detail: string };

export async function testConnection(
	credentials: GraphCredentials,
	fetchImpl: FetchLike = fetch
): Promise<TestStep[]> {
	const steps: TestStep[] = [];
	const tokens = new TokenSource(credentials, fetchImpl);
	try {
		await tokens.accessToken();
		steps.push({ name: 'Sign in to Microsoft Entra', ok: true, detail: 'Signed in as the app.' });
	} catch (error) {
		steps.push({ name: 'Sign in to Microsoft Entra', ok: false, detail: message(error) });
		return steps;
	}
	const client = new GraphClient(tokens, fetchImpl);
	let userId: string | null;
	try {
		const page = asRecord(await client.getJson('/v1.0/users?$select=id,mail&$top=5'));
		const users = Array.isArray(page['value']) ? page['value'].map(asRecord) : [];
		const withMail = users.find((user) => stringField(user, 'mail') !== null);
		userId = withMail === undefined ? null : stringField(withMail, 'id');
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
	if (userId === null) {
		steps.push({
			name: 'Read a mailbox',
			ok: false,
			detail: 'No user with a mail address to try.'
		});
		return steps;
	}
	try {
		await client.getJson(
			`/v1.0/users/${encodeURIComponent(userId)}/mailboxSettings?$select=userPurpose`
		);
		steps.push({
			name: 'Read mailbox settings (MailboxSettings.Read)',
			ok: true,
			detail: 'Allowed.'
		});
	} catch (error) {
		steps.push({
			name: 'Read mailbox settings (MailboxSettings.Read)',
			ok: false,
			detail: permissionHint(error, 'MailboxSettings.Read')
		});
	}
	try {
		await client.getJson(`/v1.0/users/${encodeURIComponent(userId)}/mailFolders?$top=1&$select=id`);
		steps.push({ name: 'Read mail (Mail.Read)', ok: true, detail: 'Allowed.' });
	} catch (error) {
		steps.push({
			name: 'Read mail (Mail.Read)',
			ok: false,
			detail: permissionHint(error, 'Mail.Read')
		});
	}
	return steps;
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
