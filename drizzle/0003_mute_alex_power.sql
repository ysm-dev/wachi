DROP INDEX `idx_delivery_outbox_claim`;--> statement-breakpoint
CREATE INDEX `idx_delivery_outbox_claim` ON `delivery_outbox` (`destination_id`,`state`,`available_at`,`enqueued_seq`);