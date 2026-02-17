import { eq } from "drizzle-orm";
import type { WachiDb } from "./connect.ts";
import { meta } from "./schema.ts";
import { metaSelectSchema } from "./zod.ts";

export const getMetaValue = (db: WachiDb, key: string): string | null => {
  const row = db.select().from(meta).where(eq(meta.key, key)).limit(1).get();

  if (!row) {
    return null;
  }

  const parsed = metaSelectSchema.safeParse(row);
  if (!parsed.success) {
    return null;
  }

  return parsed.data.value;
};
