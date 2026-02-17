import { z } from "zod";
import { buildDedupHash } from "./build-dedup-hash.ts";
import type { WachiDb } from "./connect.ts";
import { sentItems } from "./schema.ts";

const dedupItemInputSchema = z.object({
  channelUrl: z.string(),
  subscriptionUrl: z.string(),
  title: z.string(),
  link: z.string(),
});

export type DedupItemInput = z.infer<typeof dedupItemInputSchema>;

export const insertDedupRecord = (db: WachiDb, item: DedupItemInput): boolean => {
  const dedupHash = buildDedupHash(item.channelUrl, item.title, item.link);
  const inserted = db
    .insert(sentItems)
    .values({
      dedupHash,
      channelUrl: item.channelUrl,
      subscriptionUrl: item.subscriptionUrl,
      title: item.title,
      link: item.link,
      sentAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: sentItems.dedupHash })
    .returning({ id: sentItems.id })
    .get();

  return inserted !== undefined;
};
