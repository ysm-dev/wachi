import { z } from "zod";
import { maskAppriseUrl, printStderr, printStdout } from "../cli/io.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { buildDedupHash } from "../db/build-dedup-hash.ts";
import type { WachiDb } from "../db/connect.ts";
import { deleteDedupRecord } from "../db/delete-dedup-record.ts";
import { hasDedupHash } from "../db/has-dedup-hash.ts";
import { insertDedupRecord } from "../db/insert-dedup-record.ts";
import { formatNotificationBody } from "../notify/format.ts";
import { sendNotification } from "../notify/send.ts";
import { buildItemSummary } from "../subscriptions/summary.ts";

const sentRecordSchema = z.object({
  title: z.string(),
  link: z.string(),
  channel_apprise_url: z.string(),
});

export type SentRecord = z.infer<typeof sentRecordSchema>;

const checkStatsSchema = z.object({
  sent: z.array(sentRecordSchema),
  skipped: z.number(),
  errors: z.array(z.string()),
});

export type CheckStats = z.infer<typeof checkStatsSchema>;

const itemSchema = z.object({
  title: z.string(),
  link: z.string(),
});

type Item = z.infer<typeof itemSchema>;

const enqueueForChannelSchema =
  z.custom<(channelUrl: string, task: () => Promise<void>) => Promise<void>>();

const handleItemsOptionsSchema = z.object({
  items: z.array(itemSchema),
  channelUrl: z.string(),
  effectiveChannelUrl: z.string(),
  subscriptionUrl: z.string(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  config: z.custom<ResolvedConfig>(),
  stats: z.custom<CheckStats>(),
  enqueueForChannel: enqueueForChannelSchema,
});

type HandleItemsOptions = z.infer<typeof handleItemsOptionsSchema>;

const pushSent = (stats: CheckStats, item: Item, channelUrl: string): void => {
  stats.sent.push({
    title: item.title,
    link: item.link,
    channel_apprise_url: channelUrl,
  });
};

export const handleSubscriptionItems = async ({
  items,
  channelUrl,
  effectiveChannelUrl,
  subscriptionUrl,
  db,
  dryRun,
  isJson,
  isVerbose,
  config,
  stats,
  enqueueForChannel,
}: HandleItemsOptions): Promise<void> => {
  for (const item of items) {
    const dedupHash = buildDedupHash(channelUrl, item.title, item.link);

    if (dryRun) {
      if (hasDedupHash(db, dedupHash)) {
        stats.skipped += 1;
        continue;
      }
      pushSent(stats, item, channelUrl);
      if (!isJson) {
        printStdout(`[dry-run] would send: ${item.title} -> ${maskAppriseUrl(channelUrl)}`);
      }
      continue;
    }

    const inserted = insertDedupRecord(db, {
      channelUrl,
      subscriptionUrl,
      title: item.title,
      link: item.link,
    });

    if (!inserted) {
      stats.skipped += 1;
      if (isVerbose) {
        printStderr(`[verbose] skip: ${item.title} (already sent)`);
      }
      continue;
    }

    const summary = await buildItemSummary(item.link, config, isVerbose);
    const body = formatNotificationBody(item.link, item.title, summary ?? undefined);

    try {
      await enqueueForChannel(effectiveChannelUrl, async () => {
        await sendNotification({ appriseUrl: effectiveChannelUrl, body });
      });
      pushSent(stats, item, channelUrl);
      if (!isJson) {
        printStdout(`sent: ${item.title} -> ${maskAppriseUrl(channelUrl)}`);
      }
    } catch (error) {
      deleteDedupRecord(db, dedupHash);
      stats.errors.push(error instanceof Error ? error.message : "notification failed");
    }
  }
};
