-- message_content moves to the content file (lookstow-content.db). The running service moves its rows a batch at a time and drops the empty table itself (services/search-index/legacy-content.ts), so the text already read is not read again; dropping it here would throw that away.
CREATE INDEX `messages_mailbox_received` ON `messages` (`mailbox_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `messages_received` ON `messages` (`received_at`);
