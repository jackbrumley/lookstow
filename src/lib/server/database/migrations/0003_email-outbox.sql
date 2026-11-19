CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`alert` text,
	`recipient` text NOT NULL,
	`address` text NOT NULL,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`body_html` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `emails_created` ON `emails` (`created_at`);--> statement-breakpoint
CREATE INDEX `emails_due` ON `emails` (`status`,`next_attempt_at`);