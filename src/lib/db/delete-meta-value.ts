import { eq } from "drizzle-orm";
import type { WachiDb } from "./connect.ts";
import { meta } from "./schema.ts";

export const deleteMetaValue = (db: WachiDb, key: string): void => {
  db.delete(meta).where(eq(meta.key, key)).run();
};
