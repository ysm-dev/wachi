CREATE TABLE IF NOT EXISTS `destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity_key` blob NOT NULL,
	CONSTRAINT "destinations_identity_key_length" CHECK(length("destinations"."identity_key") = 32)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `destinations_identity_key_unique` ON `destinations` (`identity_key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `delivery_keys` (
	`destination_id` integer NOT NULL,
	`link_key` blob NOT NULL,
	PRIMARY KEY(`destination_id`, `link_key`),
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_keys_link_key_length" CHECK(length("delivery_keys"."link_key") = 32)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `delivery_outbox` (
	`destination_id` integer NOT NULL,
	`link_key` blob NOT NULL,
	`payload` text NOT NULL,
	`source` text NOT NULL,
	`link` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`enqueued_seq` integer NOT NULL,
	`available_at` integer NOT NULL,
	`lease_expires_at` integer,
	`last_error` text,
	PRIMARY KEY(`destination_id`, `link_key`),
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_outbox_link_key_length" CHECK(length("delivery_outbox"."link_key") = 32),
	CONSTRAINT "delivery_outbox_state_check" CHECK("delivery_outbox"."state" IN ('pending', 'reserved', 'dispatching', 'uncertain')),
	CONSTRAINT "delivery_outbox_attempts_check" CHECK("delivery_outbox"."attempts" >= 0)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_delivery_outbox_claim` ON `delivery_outbox` (`destination_id`,`state`,`available_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_delivery_outbox_active_destination` ON `delivery_outbox` (`destination_id`) WHERE "delivery_outbox"."state" IN ('reserved', 'dispatching');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `schema_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` text NOT NULL
) STRICT, WITHOUT ROWID;
