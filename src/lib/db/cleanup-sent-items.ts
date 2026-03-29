import { asc, count, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import type { WachiDb } from "./connect.ts";
import { sentItems } from "./schema.ts";

const DELETE_BATCH_SIZE = 400;

const cleanupResultSchema = z.object({
  deletedByTtl: z.number(),
  deletedByCap: z.number(),
});

export type CleanupResult = z.infer<typeof cleanupResultSchema>;

const chunkIds = (ids: number[]): number[][] => {
  const chunks: number[][] = [];
  for (let index = 0; index < ids.length; index += DELETE_BATCH_SIZE) {
    chunks.push(ids.slice(index, index + DELETE_BATCH_SIZE));
  }
  return chunks;
};

const countSentItems = (db: WachiDb): number => {
  const row = db.select({ count: count() }).from(sentItems).get();
  return Number(row?.count ?? 0);
};

export const cleanupSentItems = (
  db: WachiDb,
  ttlDays: number,
  maxRecords: number,
): CleanupResult => {
  const threshold = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const countBeforeTtl = countSentItems(db);
  db.delete(sentItems).where(lt(sentItems.sentAt, threshold)).run();
  const countAfterTtl = countSentItems(db);
  const deletedByTtl = Math.max(0, countBeforeTtl - countAfterTtl);

  if (countAfterTtl <= maxRecords) {
    return { deletedByTtl, deletedByCap: 0 };
  }

  const overBy = countAfterTtl - maxRecords;
  const oldestIds = db
    .select({ id: sentItems.id })
    .from(sentItems)
    .orderBy(asc(sentItems.sentAt))
    .limit(overBy)
    .all()
    .map((row) => row.id)
    .filter((id) => id !== null);

  if (oldestIds.length === 0) {
    return { deletedByTtl, deletedByCap: 0 };
  }

  for (const batch of chunkIds(oldestIds)) {
    db.delete(sentItems).where(inArray(sentItems.id, batch)).run();
  }

  const deletedByCap = oldestIds.length;

  return {
    deletedByTtl,
    deletedByCap,
  };
};
