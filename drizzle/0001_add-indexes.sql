CREATE INDEX IF NOT EXISTS `idx_sent_items_sent_at` ON `sent_items` (`sent_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sent_items_channel_url` ON `sent_items` (`channel_url`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sent_items_subscription_url` ON `sent_items` (`subscription_url`);
