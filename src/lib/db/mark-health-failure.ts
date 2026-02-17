import type { WachiDb } from "./connect.ts";
import type { HealthState } from "./get-health-state.ts";
import { getHealthState } from "./get-health-state.ts";
import { health } from "./schema.ts";

export const markHealthFailure = (
  db: WachiDb,
  channelUrl: string,
  subscriptionUrl: string,
  errorMessage: string,
): HealthState => {
  const current = getHealthState(db, channelUrl, subscriptionUrl);
  const nextFailures = current.consecutiveFailures + 1;
  const now = new Date().toISOString();

  db.insert(health)
    .values({
      channelUrl,
      subscriptionUrl,
      consecutiveFailures: nextFailures,
      lastError: errorMessage,
      lastFailureAt: now,
    })
    .onConflictDoUpdate({
      target: [health.channelUrl, health.subscriptionUrl],
      set: {
        consecutiveFailures: nextFailures,
        lastError: errorMessage,
        lastFailureAt: now,
      },
    })
    .run();

  return {
    channelUrl,
    subscriptionUrl,
    consecutiveFailures: nextFailures,
    lastError: errorMessage,
    lastFailureAt: now,
  };
};
