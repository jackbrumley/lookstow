CREATE TABLE `remote_sessions` (
	`token_sha256` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`created_at` integer NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `remote_sessions_username` ON `remote_sessions` (`username`);