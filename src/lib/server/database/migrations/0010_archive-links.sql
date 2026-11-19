ALTER TABLE `messages` ADD `left_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `archive_copy_id` text REFERENCES messages(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `messages_internet_id` ON `messages` (`internet_message_id`);--> statement-breakpoint
CREATE INDEX `messages_archive_copy` ON `messages` (`archive_copy_id`);