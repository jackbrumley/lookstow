/**
 * Email alerts: the kinds of alert a person on the list can be sent, and the shapes the Alerts
 * page shows. The keys are stored in the settings, so a key is never renamed (labels can change).
 * The order here is the order on the page.
 */
export const ALERT_TYPES = [
	'mailbox-problems',
	'discovery-problems',
	'disk',
	'index-snapshot',
	'completeness',
	'mailboxes-changed',
	'first-copy',
	'backups-deleted',
	'updates'
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_LABELS: Record<AlertType, { label: string; description: string }> = {
	'mailbox-problems': {
		label: 'A mailbox stops backing up, or starts again',
		description:
			'A mailbox or online archive fails to sync (with Microsoft’s reason), and when it syncs again'
	},
	'discovery-problems': {
		label: 'Mailboxes cannot be listed',
		description: 'Discovery fails, so new mailboxes are not found until it works again'
	},
	disk: {
		label: 'The backup drive is full',
		description: 'The disk guard paused every backup because the backup drive reached its limit'
	},
	'index-snapshot': {
		label: 'The index cannot be copied',
		description:
			'The daily copy of the index onto the backup drive failed, so losing the index now would lose every mailbox’s folder history'
	},
	completeness: {
		label: 'A folder stays different from Microsoft',
		description:
			'A folder’s stored messages have differed from Microsoft’s count for a day, and reading the folder again from the start did not close the gap'
	},
	'mailboxes-changed': {
		label: 'Mailboxes found or gone',
		description: 'Discovery found new mailboxes, or mailboxes are gone from Microsoft 365'
	},
	'first-copy': {
		label: 'First full copy finished',
		description: 'A mailbox’s first full copy is complete: from here it is kept up to date'
	},
	'backups-deleted': {
		label: 'Backups deleted, or what is backed up changed',
		description:
			'Someone in the console deleted a mailbox’s backup, excluded or included a mailbox, or picked or unpicked one'
	},
	updates: {
		label: 'Automatic updates',
		description: 'Lookstow started an automatic update to a new version'
	}
};

/** Where Mailgun sends from: its US or EU region (each has its own API host). */
export const MAILGUN_REGIONS = ['us', 'eu'] as const;
export type MailgunRegion = (typeof MAILGUN_REGIONS)[number];

export type AlertRecipient = {
	id: string;
	name: string;
	email: string;
	enabled: boolean;
	alerts: AlertType[];
};

export type EmailStatus = 'queued' | 'sent' | 'failed' | 'not-sent';

export type EmailView = {
	id: string;
	alert: AlertType | null;
	recipient: string;
	address: string;
	subject: string;
	status: EmailStatus;
	attempts: number;
	lastError: string | null;
	createdAt: string;
	sentAt: string | null;
};

/** The Mailgun setup as the page shows it: never the key, only a hint of it. */
export type MailgunView =
	| { kind: 'none' }
	| {
			kind: 'set';
			domain: string;
			from: string;
			region: MailgunRegion;
			keyHint: string;
			setAt: string;
	  };
