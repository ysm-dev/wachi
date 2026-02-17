import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sentItems = sqliteTable(
  "sent_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dedupHash: text("dedup_hash").notNull().unique(),
    channelUrl: text("channel_url").notNull(),
    subscriptionUrl: text("subscription_url").notNull(),
    title: text("title"),
    link: text("link"),
    sentAt: text("sent_at").notNull(),
  },
  (table) => [
    index("idx_sent_items_sent_at").on(table.sentAt),
    index("idx_sent_items_channel_url").on(table.channelUrl),
    index("idx_sent_items_subscription_url").on(table.subscriptionUrl),
  ],
);

export const health = sqliteTable(
  "health",
  {
    channelUrl: text("channel_url").notNull(),
    subscriptionUrl: text("subscription_url").notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: text("last_error"),
    lastFailureAt: text("last_failure_at"),
  },
  (table) => [primaryKey({ columns: [table.channelUrl, table.subscriptionUrl] })],
);

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const dbSchema = {
  sentItems,
  health,
  meta,
};
