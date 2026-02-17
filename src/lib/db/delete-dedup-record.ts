import { eq } from "drizzle-orm";
import type { WachiDb } from "./connect.ts";
import { sentItems } from "./schema.ts";

export const deleteDedupRecord = (db: WachiDb, dedupHash: string): void => {
  db.delete(sentItems).where(eq(sentItems.dedupHash, dedupHash)).run();
};
