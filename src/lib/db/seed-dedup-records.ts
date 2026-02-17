import { z } from "zod";
import type { WachiDb } from "./connect.ts";
import { insertDedupRecord } from "./insert-dedup-record.ts";

const dedupSeedItemSchema = z.object({
  title: z.string(),
  link: z.string(),
});

type DedupSeedItem = z.infer<typeof dedupSeedItemSchema>;

export const seedDedupRecords = (
  db: WachiDb,
  channelUrl: string,
  subscriptionUrl: string,
  items: DedupSeedItem[],
): number => {
  let inserted = 0;

  for (const item of items) {
    const didInsert = insertDedupRecord(db, {
      channelUrl,
      subscriptionUrl,
      title: item.title,
      link: item.link,
    });
    if (didInsert) {
      inserted += 1;
    }
  }

  return inserted;
};
