/** Browser-safe shapes for Search and the message page. */
export type MessageHit = {
	id: string;
	mailboxId: string;
	mailboxAddress: string;
	/** The mailbox's kind: an archive item has no subject, sender or recipients yet. */
	mailboxKind: string;
	folderPath: string;
	subject: string;
	sender: string;
	recipients: string;
	receivedAt: string | null;
	byteCount: number;
	deletedAt: string | null;
};

export type MessageEvent = {
	at: string;
	kind: 'stored' | 'moved' | 'deleted' | 'restored' | 'archived';
	fromFolderPath: string | null;
	toFolderPath: string | null;
};

export type MessageDetail = MessageHit & {
	graphId: string;
	internetMessageId: string | null;
	sha256: string;
	filePath: string;
	storedAt: string;
	/** When it left its mailbox for the online archive (or, if never found there, before deletion). */
	leftAt: string | null;
	/** The same email's other copy: in the person's online archive, or in their mailbox. */
	otherCopy: { id: string; mailboxAddress: string; mailboxKind: string; folderPath: string } | null;
	history: MessageEvent[];
};

export type MessageQuery = {
	mailboxId: string | null;
	/** Words that must appear in the subject, sender or recipients. */
	text: string;
	from: string;
	to: string;
	subject: string;
	folder: string;
	messageId: string;
	/** yyyy-mm-dd, inclusive. */
	after: string;
	before: string;
	includeDeleted: boolean;
};

export const SEARCH_PAGE_SIZE = 100;
