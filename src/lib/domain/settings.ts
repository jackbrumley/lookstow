/**
 * Browser-safe settings: what the Settings page shows. Secrets never leave the server; the
 * page sees only whether one is set and a hint.
 */
export type ConnectionView = {
	tenantId: string;
	clientId: string;
	auth:
		| { kind: 'none' }
		| { kind: 'secret'; hint: string; setAt: string }
		| {
				kind: 'certificate';
				thumbprint: string;
				validTo: string;
				certificatePem: string;
		  };
};

export type ScopeSettings = {
	/**
	 * `all`: every mailbox discovery finds, minus the exclusions and kinds turned off.
	 * `selected`: only the addresses in `selectedAddresses` (any kind), for a trial or a small set.
	 */
	mode: 'all' | 'selected';
	/** With `selected`: the addresses backed up, lower case. Their online archives follow. */
	selectedAddresses: string[];
	/** Shared mailboxes (always recommended: they are what people lose most). */
	includeShared: boolean;
	/** Room and equipment mailboxes (mostly calendar, little mail). */
	includeResources: boolean;
	includeArchives: boolean;
	/** Addresses never backed up, lower case. */
	excludedAddresses: string[];
};

export type DiskSettings = {
	/** Warn on the dashboard (and by email) from this much of the backup drive used. */
	warnPercent: number;
	/** Pause every sync from this much used. */
	pausePercent: number;
};

export const DISK_DEFAULTS: DiskSettings = { warnPercent: 85, pausePercent: 90 };

export type ScheduleSettings = {
	/** Minutes between sync passes over every mailbox. */
	syncEveryMinutes: number;
	/** Hours between discovery runs. */
	discoverEveryHours: number;
	/** At most this many mailboxes sync at the same time (fewer while Graph throttles). */
	parallelMailboxes: number;
	/** While paused nothing syncs, not even Sync now, and running syncs stop after their page. */
	paused: boolean;
	/** Who paused: someone in the console, or the disk guard. Null while running. */
	pausedReason: 'manual' | 'disk' | null;
	pausedAt: string | null;
};

export type BackupSettings = {
	/** Absolute folder for the backups; null means the default beside the database. */
	root: string | null;
};

export type UpdateSettings = {
	/** Install a new signed release by itself, soon after the daily check finds one. */
	automatic: boolean;
};

export type SettingsView = {
	connection: ConnectionView;
	scope: ScopeSettings;
	schedule: ScheduleSettings;
	backup: BackupSettings & { effectiveRoot: string };
	updates: UpdateSettings;
	disk: DiskSettings;
};

export const SCOPE_DEFAULTS: ScopeSettings = {
	mode: 'all',
	selectedAddresses: [],
	includeShared: true,
	includeResources: false,
	includeArchives: true,
	excludedAddresses: []
};

export const SCHEDULE_DEFAULTS: ScheduleSettings = {
	syncEveryMinutes: 15,
	discoverEveryHours: 6,
	parallelMailboxes: 8,
	paused: false,
	pausedReason: null,
	pausedAt: null
};

export const UPDATE_DEFAULTS: UpdateSettings = { automatic: true };

export const SCHEDULE_LIMITS = {
	syncEveryMinutes: { min: 5, max: 1440 },
	discoverEveryHours: { min: 1, max: 168 },
	parallelMailboxes: { min: 1, max: 32 }
} as const;

/** Exchange purposes Lookstow treats as resources (rooms, equipment). */
export const RESOURCE_KINDS = ['room', 'equipment'] as const;
