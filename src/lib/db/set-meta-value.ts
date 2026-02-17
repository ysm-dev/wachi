import type { WachiDb } from "./connect.ts";
import { meta } from "./schema.ts";

export const setMetaValue = (db: WachiDb, key: string, value: string): void => {
  db.insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({
      target: meta.key,
      set: { value },
    })
    .run();
};
