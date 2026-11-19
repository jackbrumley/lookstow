CREATE TABLE `message_content` (
	`message_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`attachment_count` integer DEFAULT 0 NOT NULL,
	`image_count` integer DEFAULT 0 NOT NULL,
	`pdf_count` integer DEFAULT 0 NOT NULL,
	`largest_attachment_bytes` integer DEFAULT 0 NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`problem` text,
	`indexed_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_content_images` ON `message_content` (`image_count`,`pdf_count`);