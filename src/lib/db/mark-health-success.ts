import type { WachiDb } from "./connect.ts";
import { health } from "./schema.ts";

export const markHealthSuccess = (
  db: WachiDb,
  channelUrl: string,
  subscriptionUrl: string,
): void => {
  db.insert(health)
    .values({
      channelUrl,
      subscriptionUrl,
      consecutiveFailures: 0,
      lastError: null,
      lastFailureAt: null,
    })
    .onConflictDoUpdate({
      target: [health.channelUrl, health.subscriptionUrl],
      set: {
        consecutiveFailures: 0,
        lastError: null,
        lastFailureAt: null,
      },
    })
    .run();
};
