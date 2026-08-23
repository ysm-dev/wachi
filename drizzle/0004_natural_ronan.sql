PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_delivery_outbox` (
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
	`claim_generation` integer DEFAULT 0 NOT NULL,
	`claim_owner` text,
	`last_error` text,
	PRIMARY KEY(`destination_id`, `link_key`),
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_outbox_link_key_length" CHECK(length("link_key") = 32),
	CONSTRAINT "delivery_outbox_state_check" CHECK("state" IN ('pending', 'reserved', 'dispatching', 'uncertain')),
	CONSTRAINT "delivery_outbox_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "delivery_outbox_claim_generation_check" CHECK("claim_generation" >= 0)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO `__new_delivery_outbox`("destination_id", "link_key", "payload", "source", "link", "state", "attempts", "enqueued_seq", "available_at", "lease_expires_at", "claim_generation", "claim_owner", "last_error") SELECT "destination_id", "link_key", "payload", "source", "link", CASE WHEN "state" IN ('reserved', 'dispatching', 'uncertain') THEN 'pending' ELSE "state" END, "attempts", "enqueued_seq", "available_at", NULL, 0, NULL, "last_error" FROM `delivery_outbox`;--> statement-breakpoint
DROP TABLE `delivery_outbox`;--> statement-breakpoint
ALTER TABLE `__new_delivery_outbox` RENAME TO `delivery_outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_delivery_outbox_claim` ON `delivery_outbox` (`destination_id`,`state`,`available_at`,`enqueued_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_delivery_outbox_active_destination` ON `delivery_outbox` (`destination_id`) WHERE "delivery_outbox"."state" IN ('reserved', 'dispatching');
