CREATE TABLE `message_events` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`from_folder_path` text,
	`to_folder_path` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_events_message` ON `message_events` (`message_id`,`at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `recipients` text DEFAULT '' NOT NULL;