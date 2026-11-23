DROP INDEX `messages_folder`;--> statement-breakpoint
CREATE INDEX `messages_folder_live` ON `messages` (`folder_id`,`deleted_at`,`left_at`,`graph_id`);--> statement-breakpoint
CREATE INDEX `messages_left_pending` ON `messages` (`mailbox_id`,`left_at`) WHERE "messages"."left_at" is not null and "messages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `messages_unreadable` ON `messages` (`mailbox_id`) WHERE "messages"."index_failed_version" is not null;--> statement-breakpoint
ALTER TABLE `mail_folders` ADD `listed_count` integer;--> statement-breakpoint
ALTER TABLE `mail_folders` ADD `listed_at` integer;--> statement-breakpoint
ALTER TABLE `mail_folders` ADD `count_from_listing` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mail_folders` ADD `optional` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `archive_parts` integer;