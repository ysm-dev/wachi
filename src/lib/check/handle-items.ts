import { z } from "zod";
import { submitArchive } from "../archive/submit.ts";
import { printStderr, printStdout } from "../cli/io.ts";
import type { LinkTransform } from "../config/schema.ts";
import { buildDedupHash } from "../db/build-dedup-hash.ts";
import type { WachiDb } from "../db/connect.ts";
import { deleteDedupRecord } from "../db/delete-dedup-record.ts";
import { hasDedupHash } from "../db/has-dedup-hash.ts";
import { insertDedupRecord } from "../db/insert-dedup-record.ts";
import { formatNotificationBody } from "../notify/format.ts";
import { sendNotification } from "../notify/send.ts";
import type { SourceIdentity } from "../notify/source-identity.ts";
import { withLinkFallbackAvatar } from "../subscriptions/resolve-source-identity.ts";
import { transformLink } from "../url/transform.ts";

const sentRecordSchema = z.object({
  title: z.string(),
  link: z.string(),
  channel_name: z.string(),
});

export type SentRecord = z.infer<typeof sentRecordSchema>;

const checkStatsSchema = z.object({
  sent: z.array(sentRecordSchema),
  skipped: z.number(),
  errors: z.array(z.string()),
  networkSkipped: z.number(),
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
  channelName: z.string(),
  effectiveChannelUrl: z.string(),
  subscriptionUrl: z.string(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  stats: z.custom<CheckStats>(),
  enqueueForChannel: enqueueForChannelSchema,
  sourceIdentity: z.custom<SourceIdentity>().optional(),
  linkTransforms: z.custom<LinkTransform[]>(),
});

type HandleItemsOptions = z.infer<typeof handleItemsOptionsSchema>;

const pushSent = (stats: CheckStats, item: Item, channelName: string): void => {
  stats.sent.push({
    title: item.title,
    link: item.link,
    channel_name: channelName,
  });
};

export const handleSubscriptionItems = async ({
  items,
  channelName,
  effectiveChannelUrl,
  subscriptionUrl,
  db,
  dryRun,
  isJson,
  isVerbose,
  stats,
  enqueueForChannel,
  sourceIdentity,
  linkTransforms,
}: HandleItemsOptions): Promise<void> => {
  for (const [index, item] of items.entries()) {
    const dedupHash = buildDedupHash(channelName, item.title, item.link);

    if (dryRun) {
      if (hasDedupHash(db, dedupHash)) {
        stats.skipped += 1;
        continue;
      }
      pushSent(stats, item, channelName);
      if (!isJson) {
        printStdout(`[dry-run] would send: ${item.title} -> ${channelName}`);
      }
      continue;
    }

    const inserted = insertDedupRecord(db, {
      channelUrl: channelName,
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

    const notificationLink = transformLink(item.link, linkTransforms);
    const body = formatNotificationBody(notificationLink, item.title);
    const itemSourceIdentity = withLinkFallbackAvatar(sourceIdentity, item.link);

    try {
      await enqueueForChannel(effectiveChannelUrl, async () => {
        await sendNotification({
          appriseUrl: effectiveChannelUrl,
          body,
          sourceIdentity: itemSourceIdentity,
        });
      });
      pushSent(stats, item, channelName);
      submitArchive(item.link, { isVerbose });
      if (!isJson) {
        printStdout(`sent: ${item.title} -> ${channelName}`);
      }
    } catch (error) {
      deleteDedupRecord(db, dedupHash);
      const reason = error instanceof Error ? error.message : "notification delivery failed";
      stats.errors.push(`${subscriptionUrl}: ${reason}`);

      const remaining = items.length - index - 1;
      if (remaining > 0 && isVerbose) {
        printStderr(
          `[verbose] aborting ${remaining} pending notifications for ${channelName} after delivery failure`,
        );
      }
      break;
    }
  }
};
