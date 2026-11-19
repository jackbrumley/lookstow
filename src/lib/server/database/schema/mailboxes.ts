import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Every mailbox discovery has found. A mailbox is never deleted here: when it disappears from
 * the tenant (licence removed, user deleted) it is marked `goneAt` and its backup stays.
 * `kind` is Exchange's own purpose (user, shared, room, equipment, linked, others) or
 * `archive` for an online archive, which is its own row pointing at its primary mailbox.
 */
export const mailboxes = sqliteTable(
	'mailboxes',
	{
		id: text().primaryKey(),
		/** The Entra user object the mailbox belongs to. */
		userId: text().notNull(),
		kind: text().notNull(),
		/** For an archive, the primary mailbox's row. */
		primaryMailboxId: text(),
		/** Exchange's mailbox id, for an archive (the beta mailbox API addresses it by this). */
		exchangeMailboxId: text(),
		address: text().notNull(),
		displayName: text().notNull(),
		/** Excluded by an admin: discovered but not backed up. */
		excluded: integer({ mode: 'boolean' }).notNull().default(false),
		/** Paused by an admin: in scope, but not synced until resumed. */
		paused: integer({ mode: 'boolean' }).notNull().default(false),
		firstSeenAt: integer({ mode: 'timestamp_ms' }).notNull(),
		lastSeenAt: integer({ mode: 'timestamp_ms' }).notNull(),
		/** When discovery stopped finding it. The backup is kept. */
		goneAt: integer({ mode: 'timestamp_ms' }),
		lastSyncStartedAt: integer({ mode: 'timestamp_ms' }),
		lastSyncFinishedAt: integer({ mode: 'timestamp_ms' }),
		/** Set when the last sync of this mailbox failed; cleared by the next success. */
		lastSyncError: text(),
		/** True once every folder has been copied in full at least once. */
		firstCopyDone: integer({ mode: 'boolean' }).notNull().default(false),
		itemCount: integer().notNull().default(0),
		byteCount: integer().notNull().default(0)
	},
	(table) => [
		uniqueIndex('mailboxes_user_kind').on(table.userId, table.kind),
		index('mailboxes_address').on(table.address)
	]
);

/** A mail folder of a mailbox, with the delta link that makes the next sync incremental. */
export const mailFolders = sqliteTable(
	'mail_folders',
	{
		id: text().primaryKey(),
		mailboxId: text()
			.notNull()
			.references(() => mailboxes.id),
		/** Graph's immutable folder id. */
		graphId: text().notNull(),
		/** Display path from the mailbox root, e.g. `Inbox/Projects`. */
		path: text().notNull(),
		/** Where its messages are stored, relative to the mailbox's backup folder. */
		storagePath: text().notNull(),
		deltaLink: text(),
		/** True once a delta round has reached its delta link (the folder's first copy is done). */
		firstCopyDone: integer({ mode: 'boolean' }).notNull().default(false),
		lastSyncedAt: integer({ mode: 'timestamp_ms' }),
		goneAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [uniqueIndex('mail_folders_mailbox_graph').on(table.mailboxId, table.graphId)]
);

/**
 * One stored message. Graph ids are immutable ids (`Prefer: IdType="ImmutableId"`), so a
 * message keeps its id when it moves between folders. Deleted messages keep their file:
 * `deletedAt` records when the source removed it.
 */
export const messages = sqliteTable(
	'messages',
	{
		id: text().primaryKey(),
		mailboxId: text()
			.notNull()
			.references(() => mailboxes.id),
		folderId: text()
			.notNull()
			.references(() => mailFolders.id),
		graphId: text().notNull(),
		internetMessageId: text(),
		subject: text().notNull(),
		sender: text().notNull(),
		/** To and Cc addresses, lower case, separated by spaces (for search). */
		recipients: text().notNull().default(''),
		receivedAt: integer({ mode: 'timestamp_ms' }),
		/** The .eml file, relative to the backup root. */
		filePath: text().notNull(),
		byteCount: integer().notNull(),
		sha256: text().notNull(),
		storedAt: integer({ mode: 'timestamp_ms' }).notNull(),
		deletedAt: integer({ mode: 'timestamp_ms' }),
		/**
		 * An online archive item the .fts reader could not read: the Lookstow version that tried.
		 * A newer version tries again; the same version does not.
		 */
		indexFailedVersion: text()
	},
	(table) => [
		uniqueIndex('messages_mailbox_graph').on(table.mailboxId, table.graphId),
		index('messages_folder').on(table.folderId)
	]
);

/**
 * Everything that happened to a stored message, in order: stored (first seen, in which folder),
 * moved between folders, deleted at the source, back again. The files never move, so this is
 * the record of where each message was and when; folder paths are copied in, so a later
 * rename of a folder does not change the history.
 */
export const messageEvents = sqliteTable(
	'message_events',
	{
		id: text().primaryKey(),
		messageId: text()
			.notNull()
			.references(() => messages.id, { onDelete: 'cascade' }),
		mailboxId: text().notNull(),
		at: integer({ mode: 'timestamp_ms' }).notNull(),
		kind: text({ enum: ['stored', 'moved', 'deleted', 'restored'] }).notNull(),
		fromFolderPath: text(),
		toFolderPath: text()
	},
	(table) => [index('message_events_message').on(table.messageId, table.at)]
);
