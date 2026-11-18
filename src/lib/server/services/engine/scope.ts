import { RESOURCE_KINDS, type ScopeSettings } from '../../../domain/settings.ts';

/** Whether the settings say a mailbox is backed up. Excluded and out-of-scope ones are not. */
export function inScope(
	mailbox: { kind: string; address: string; excluded: boolean },
	scope: ScopeSettings
): boolean {
	if (mailbox.excluded || scope.excludedAddresses.includes(mailbox.address.toLowerCase())) {
		return false;
	}
	if (mailbox.kind === 'shared') {
		return scope.includeShared;
	}
	if (RESOURCE_KINDS.some((kind) => kind === mailbox.kind)) {
		return scope.includeResources;
	}
	if (mailbox.kind === 'archive') {
		return scope.includeArchives;
	}
	return true;
}
