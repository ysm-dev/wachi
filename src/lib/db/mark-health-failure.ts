import { and, eq, sql } from "drizzle-orm";
import type { WachiDbSession } from "./connect.ts";
import type { HealthState } from "./get-health-state.ts";
import { getHealthState } from "./get-health-state.ts";
import { beginHealthAttempt } from "./health-attempt.ts";
import { health } from "./schema.ts";

export const markHealthFailure = (
  db: WachiDbSession,
  channelUrl: string,
  subscriptionUrl: string,
  errorMessage: string,
  attemptGeneration?: number,
): HealthState => {
  const generation = attemptGeneration ?? beginHealthAttempt(db, channelUrl, subscriptionUrl);
  const failedAt = new Date().toISOString();
  const updated = db
    .update(health)
    .set({
      consecutiveFailures: sql`${health.consecutiveFailures} + 1`,
      lastError: errorMessage,
      lastFailureAt: failedAt,
    })
    .where(
      and(
        eq(health.channelUrl, channelUrl),
        eq(health.subscriptionUrl, subscriptionUrl),
        eq(health.attemptGeneration, generation),
      ),
    )
    .returning()
    .get();

  return updated ?? getHealthState(db, channelUrl, subscriptionUrl);
};
