/**
 * What kind of failure stopped a mailbox's sync, read from its error text, so the dashboard can
 * say "3 failing: 2 permission, 1 network" and the cause is clear at a glance
 * (docs/specs/SPEC-THROUGHPUT.md 4.9.6). Browser-safe.
 */
export type FailureKind = 'throttled' | 'network' | 'permission' | 'disk' | 'microsoft' | 'other';

export const FAILURE_KIND_LABEL: Record<FailureKind, string> = {
	throttled: 'slowed down by Microsoft',
	network: 'network',
	permission: 'permission',
	disk: 'disk',
	microsoft: 'Microsoft error',
	other: 'other'
};

const KINDS: readonly FailureKind[] = [
	'throttled',
	'network',
	'permission',
	'disk',
	'microsoft',
	'other'
];

const RULES: readonly [FailureKind, RegExp][] = [
	['throttled', /\b429\b|throttl|too many requests|ApplicationThrottled|MailboxConcurrency/i],
	[
		'permission',
		/\b40[13]\b|access ?denied|forbidden|unauthori[sz]ed|permission|consent|AADSTS|ErrorAccessDenied/i
	],
	[
		'disk',
		/\b(ENOSPC|EACCES|EPERM|EROFS|EIO|EMFILE|ENFILE)\b|no space|disk|backup folder|read-only file/i
	],
	[
		'network',
		/\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR\w*)\b|fetch failed|socket|timed? ?out|network|broken reply/i
	],
	['microsoft', /\b5\d\d\b|Microsoft|Graph|ErrorInternalServerError|ServiceUnavailable/i]
];

export function failureKind(error: string): FailureKind {
	for (const [kind, pattern] of RULES) {
		if (pattern.test(error)) return kind;
	}
	return 'other';
}

/** "2 permission, 1 network": the kinds of failure, most common first. */
export function failureSummary(counts: Partial<Record<FailureKind, number>>): string {
	return KINDS.map((kind) => ({ kind, count: counts[kind] ?? 0 }))
		.filter((entry) => entry.count > 0)
		.sort((a, b) => b.count - a.count)
		.map((entry) => `${String(entry.count)} ${FAILURE_KIND_LABEL[entry.kind]}`)
		.join(', ');
}
