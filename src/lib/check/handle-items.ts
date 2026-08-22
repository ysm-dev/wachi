import { z } from "zod";
import { printStderr, printStdout } from "../cli/io.ts";
import type { LinkTransform } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import {
  admitDeliveriesWithOutbox,
  admitDeliveryKeys,
  type DeliveryAdmission,
  hasDeliveryKey,
} from "../db/delivery-ledger.ts";
import { serializeDeliverySource } from "../notify/delivery-source.ts";
import { formatNotificationBody } from "../notify/format.ts";
import type { SourceIdentity } from "../notify/source-identity.ts";
import { buildLinkKey } from "../subscriptions/item-identity.ts";
import { withLinkFallbackAvatar } from "../subscriptions/resolve-source-identity.ts";
import { canonicalizeItemUrl } from "../url/canonicalize-item-url.ts";
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

type PreparedItem = {
  item: Item;
  canonicalLink: string;
  linkKey: Buffer;
};

const handleItemsOptionsSchema = z.object({
  items: z.array(itemSchema),
  channelName: z.string(),
  destinationId: z.number().int().positive(),
  subscriptionUrl: z.string(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  baseline: z.boolean().default(false),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  stats: z.custom<CheckStats>(),
  sourceIdentity: z.custom<SourceIdentity>().optional(),
  linkTransforms: z.custom<LinkTransform[]>(),
  // Effective destination Apprise URL, used only to look up the scheme's
  // upstream body-length limit (see notify/format.ts). Optional so existing
  // callers/tests that don't know the destination keep prior behavior.
  appriseUrl: z.string().optional(),
});

type HandleItemsOptions = z.infer<typeof handleItemsOptionsSchema>;

const stripWww = (hostname: string): string => {
  return hostname.replace(/^www\./, "");
};

const shouldArchiveNotificationLink = (originalLink: string): boolean => {
  try {
    const hostname = stripWww(new URL(originalLink).hostname);
    return hostname === "x.com" || hostname === "twitter.com";
  } catch {
    return false;
  }
};

const resolveArchiveLink = (originalLink: string, notificationLink: string): string => {
  return shouldArchiveNotificationLink(originalLink) ? notificationLink : originalLink;
};

const pushDryRun = (stats: CheckStats, item: Item, channelName: string): void => {
  stats.sent.push({ title: item.title, link: item.link, channel_name: channelName });
};

export const handleSubscriptionItems = async ({
  items,
  channelName,
  destinationId,
  subscriptionUrl,
  db,
  dryRun,
  baseline,
  isJson,
  isVerbose,
  stats,
  sourceIdentity,
  linkTransforms,
  appriseUrl,
}: HandleItemsOptions): Promise<number> => {
  const encountered = new Set<string>();
  const preparedItems: PreparedItem[] = [];
  let accepted = 0;

  for (const item of items) {
    const canonicalLink = canonicalizeItemUrl(item.link);
    if (!canonicalLink) {
      stats.errors.push(`${subscriptionUrl}: invalid item link: ${item.link}`);
      continue;
    }

    const linkKey = buildLinkKey(canonicalLink);
    const key = linkKey.toString("hex");
    if (encountered.has(key)) {
      stats.skipped += 1;
      continue;
    }
    encountered.add(key);

    preparedItems.push({ item, canonicalLink, linkKey });
  }

  if (dryRun) {
    for (const { item, linkKey } of preparedItems) {
      if (hasDeliveryKey(db, destinationId, linkKey)) {
        stats.skipped += 1;
        continue;
      }
      pushDryRun(stats, item, channelName);
      accepted += 1;
      if (!isJson) {
        printStdout(`[dry-run] would send: ${item.title} -> ${channelName}`);
      }
    }
    return accepted;
  }

  if (baseline) {
    accepted = admitDeliveryKeys(
      db,
      destinationId,
      preparedItems.map(({ linkKey }) => linkKey),
    );
    stats.skipped += preparedItems.length;
    return accepted;
  }

  const admissions: DeliveryAdmission[] = preparedItems.map(({ item, canonicalLink, linkKey }) => {
    const notificationLink = transformLink(canonicalLink, linkTransforms);
    const itemSourceIdentity = withLinkFallbackAvatar(sourceIdentity, canonicalLink);
    return {
      destinationId,
      linkKey,
      payload: formatNotificationBody(notificationLink, item.title, appriseUrl),
      source: serializeDeliverySource({
        channelName,
        subscriptionUrl,
        title: item.title,
        archiveLink: resolveArchiveLink(canonicalLink, notificationLink),
        sourceIdentity: itemSourceIdentity,
      }),
      link: canonicalLink,
    };
  });
  const admittedItems = admitDeliveriesWithOutbox(db, admissions);

  for (let index = 0; index < admittedItems.length; index += 1) {
    const admitted = admittedItems[index] ?? false;
    const prepared = preparedItems[index];
    if (!prepared) {
      continue;
    }
    if (!admitted) {
      stats.skipped += 1;
      if (isVerbose) {
        printStderr(
          `[verbose] skip: ${prepared.item.title} (link already accepted for destination)`,
        );
      }
    } else {
      accepted += 1;
    }
  }

  return accepted;
};
