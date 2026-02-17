CREATE TABLE IF NOT EXISTS `health` (
	`channel_url` text NOT NULL,
	`subscription_url` text NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_failure_at` text,
	PRIMARY KEY(`channel_url`, `subscription_url`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sent_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedup_hash` text NOT NULL,
	`channel_url` text NOT NULL,
	`subscription_url` text NOT NULL,
	`title` text,
	`link` text,
	`sent_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sent_items_dedup_hash_unique` ON `sent_items` (`dedup_hash`);
