import { and, eq } from "drizzle-orm";
import type { WachiDb } from "./connect.ts";
import { health } from "./schema.ts";

export const markHealthSuccess = (
  db: WachiDb,
  channelUrl: string,
  subscriptionUrl: string,
): void => {
  // Absence represents healthy state, avoiding a durable row for every feed.
  db.delete(health)
    .where(and(eq(health.channelUrl, channelUrl), eq(health.subscriptionUrl, subscriptionUrl)))
    .run();
};
