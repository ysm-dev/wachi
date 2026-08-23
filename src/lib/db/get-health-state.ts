import { and, eq } from "drizzle-orm";
import type { WachiDbSession } from "./connect.ts";
import { health } from "./schema.ts";
import { type HealthRow, healthSelectSchema } from "./zod.ts";

export type HealthState = HealthRow;

export const getHealthState = (
  db: WachiDbSession,
  channelUrl: string,
  subscriptionUrl: string,
): HealthState => {
  const row = db
    .select()
    .from(health)
    .where(and(eq(health.channelUrl, channelUrl), eq(health.subscriptionUrl, subscriptionUrl)))
    .limit(1)
    .get();

  if (!row) {
    return {
      channelUrl,
      subscriptionUrl,
      consecutiveFailures: 0,
      lastError: null,
      lastFailureAt: null,
      lastAttemptAt: null,
      attemptGeneration: 0,
    };
  }

  const parsed = healthSelectSchema.safeParse(row);
  if (!parsed.success) {
    return {
      channelUrl,
      subscriptionUrl,
      consecutiveFailures: 0,
      lastError: null,
      lastFailureAt: null,
      lastAttemptAt: null,
      attemptGeneration: 0,
    };
  }

  return parsed.data;
};
