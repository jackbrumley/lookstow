CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`graph_id` text NOT NULL,
	`path` text NOT NULL,
	`storage_path` text NOT NULL,
	`delta_link` text,
	`first_copy_done` integer DEFAULT false NOT NULL,
	`last_synced_at` integer,
	`gone_at` integer,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_folders_mailbox_graph` ON `mail_folders` (`mailbox_id`,`graph_id`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`primary_mailbox_id` text,
	`exchange_mailbox_id` text,
	`address` text NOT NULL,
	`display_name` text NOT NULL,
	`excluded` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`gone_at` integer,
	`last_sync_started_at` integer,
	`last_sync_finished_at` integer,
	`last_sync_error` text,
	`first_copy_done` integer DEFAULT false NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`byte_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_user_kind` ON `mailboxes` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `mailboxes_address` ON `mailboxes` (`address`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`graph_id` text NOT NULL,
	`internet_message_id` text,
	`subject` text NOT NULL,
	`sender` text NOT NULL,
	`received_at` integer,
	`file_path` text NOT NULL,
	`byte_count` integer NOT NULL,
	`sha256` text NOT NULL,
	`stored_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folder_id`) REFERENCES `mail_folders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_mailbox_graph` ON `messages` (`mailbox_id`,`graph_id`);--> statement-breakpoint
CREATE INDEX `messages_folder` ON `messages` (`folder_id`);--> statement-breakpoint
CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`mailbox_id` text
);
--> statement-breakpoint
CREATE INDEX `activity_at` ON `activity` (`at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`mailbox_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`byte_count` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `runs_started` ON `runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `runs_mailbox` ON `runs` (`mailbox_id`);