import { and, eq } from "drizzle-orm";
import type { WachiDb } from "./connect.ts";
import { beginHealthAttempt } from "./health-attempt.ts";
import { health } from "./schema.ts";

export const markHealthSuccess = (
  db: WachiDb,
  channelUrl: string,
  subscriptionUrl: string,
  attemptGeneration?: number,
): void => {
  const generation = attemptGeneration ?? beginHealthAttempt(db, channelUrl, subscriptionUrl);
  db.update(health)
    .set({
      consecutiveFailures: 0,
      lastError: null,
      lastFailureAt: null,
    })
    .where(
      and(
        eq(health.channelUrl, channelUrl),
        eq(health.subscriptionUrl, subscriptionUrl),
        eq(health.attemptGeneration, generation),
      ),
    )
    .run();
};
