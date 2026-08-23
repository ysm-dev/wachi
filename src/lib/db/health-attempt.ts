import { sql } from "drizzle-orm";
import type { WachiDbSession } from "./connect.ts";
import { health } from "./schema.ts";

export const beginHealthAttempt = (
  db: WachiDbSession,
  channelUrl: string,
  subscriptionUrl: string,
): number => {
  const attemptedAt = new Date().toISOString();
  const row = db
    .insert(health)
    .values({
      channelUrl,
      subscriptionUrl,
      consecutiveFailures: 0,
      lastError: null,
      lastFailureAt: null,
      lastAttemptAt: attemptedAt,
      attemptGeneration: 1,
    })
    .onConflictDoUpdate({
      target: [health.channelUrl, health.subscriptionUrl],
      set: {
        lastAttemptAt: attemptedAt,
        attemptGeneration: sql`${health.attemptGeneration} + 1`,
      },
    })
    .returning({ attemptGeneration: health.attemptGeneration })
    .get();
  if (!row) {
    throw new Error("Failed to begin health attempt");
  }
  return row.attemptGeneration;
};
