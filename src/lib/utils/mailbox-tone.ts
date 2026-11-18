import type { MailboxState } from '../domain/mailboxes.ts';

/** The badge colour for each mailbox state: green when safe, red when it needs someone. */
export function stateTone(state: MailboxState): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
	switch (state) {
		case 'backed-up':
			return 'ok';
		case 'syncing':
			return 'info';
		case 'waiting-first-copy':
			return 'warn';
		case 'failed':
			return 'bad';
		case 'excluded':
		case 'out-of-scope':
		case 'gone':
			return 'neutral';
	}
}
