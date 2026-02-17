import { eq } from "drizzle-orm";
import type { WachiDb } from "./connect.ts";
import { sentItems } from "./schema.ts";

export const hasDedupHash = (db: WachiDb, dedupHash: string): boolean => {
  const row = db
    .select({ dedupHash: sentItems.dedupHash })
    .from(sentItems)
    .where(eq(sentItems.dedupHash, dedupHash))
    .limit(1)
    .get();

  return row !== undefined;
};
