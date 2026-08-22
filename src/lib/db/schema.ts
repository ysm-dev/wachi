import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const deliveryOutboxStates = ["pending", "reserved", "dispatching", "uncertain"] as const;

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

export const schemaMigrations = sqliteTable("schema_migrations", {
  id: text("id").primaryKey(),
  appliedAt: text("applied_at").notNull(),
});

export const destinations = sqliteTable(
  "destinations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    identityKey: blob("identity_key", { mode: "buffer" }).notNull(),
  },
  (table) => [
    uniqueIndex("destinations_identity_key_unique").on(table.identityKey),
    check("destinations_identity_key_length", sql`length(${table.identityKey}) = 32`),
  ],
);

export const deliveryKeys = sqliteTable(
  "delivery_keys",
  {
    destinationId: integer("destination_id")
      .notNull()
      .references(() => destinations.id),
    linkKey: blob("link_key", { mode: "buffer" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.destinationId, table.linkKey] }),
    check("delivery_keys_link_key_length", sql`length(${table.linkKey}) = 32`),
  ],
);

export const deliveryOutbox = sqliteTable(
  "delivery_outbox",
  {
    destinationId: integer("destination_id")
      .notNull()
      .references(() => destinations.id),
    linkKey: blob("link_key", { mode: "buffer" }).notNull(),
    payload: text("payload").notNull(),
    source: text("source").notNull(),
    link: text("link").notNull(),
    state: text("state", { enum: deliveryOutboxStates }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    // Monotonic admission order used to deliver items oldest-first within a
    // destination, independent of the `available_at` scheduling clock.
    enqueuedSeq: integer("enqueued_seq").notNull(),
    availableAt: integer("available_at").notNull(),
    leaseExpiresAt: integer("lease_expires_at"),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.destinationId, table.linkKey] }),
    check("delivery_outbox_link_key_length", sql`length(${table.linkKey}) = 32`),
    check(
      "delivery_outbox_state_check",
      sql`${table.state} IN ('pending', 'reserved', 'dispatching', 'uncertain')`,
    ),
    check("delivery_outbox_attempts_check", sql`${table.attempts} >= 0`),
    index("idx_delivery_outbox_claim").on(
      table.destinationId,
      table.state,
      table.availableAt,
      table.enqueuedSeq,
    ),
    uniqueIndex("idx_delivery_outbox_active_destination")
      .on(table.destinationId)
      .where(sql`${table.state} IN ('reserved', 'dispatching')`),
  ],
);

export const dbSchema = {
  sentItems,
  health,
  meta,
  schemaMigrations,
  destinations,
  deliveryKeys,
  deliveryOutbox,
};
