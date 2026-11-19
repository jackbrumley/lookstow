CREATE TABLE `item_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`graph_id` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`received_at` integer,
	`attempts` integer DEFAULT 1 NOT NULL,
	`first_failed_at` integer NOT NULL,
	`next_try_at` integer NOT NULL,
	`last_error` text NOT NULL,
	`terminal` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `mail_folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_failures_item` ON `item_failures` (`mailbox_id`,`graph_id`);--> statement-breakpoint
CREATE INDEX `item_failures_due` ON `item_failures` (`folder_id`,`terminal`,`next_try_at`);