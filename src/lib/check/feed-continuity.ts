import { WachiError } from "../../utils/error.ts";
import { sha256 } from "../../utils/hash.ts";
import type { WachiDb } from "../db/connect.ts";
import { deleteMetaValue } from "../db/delete-meta-value.ts";
import { hasDeliveryKey } from "../db/delivery-ledger.ts";
import { getMetaValue } from "../db/get-meta-value.ts";
import { setMetaValue } from "../db/set-meta-value.ts";
import { buildLinkKey } from "../subscriptions/item-identity.ts";
import type { SubscriptionItem } from "../subscriptions/subscription-item.ts";

type FeedContinuitySelection = {
  baselineItems: SubscriptionItem[];
  deliveryItems: SubscriptionItem[];
};

const continuityScope = (destinationId: number, rssUrl: string): string =>
  `${destinationId}:${sha256(rssUrl)}`;

const watermarkKey = (destinationId: number, rssUrl: string): string =>
  `feed-watermark:v1:${continuityScope(destinationId, rssUrl)}`;

const backfillKey = (destinationId: number, rssUrl: string): string =>
  `feed-backfill:v1:${continuityScope(destinationId, rssUrl)}`;

const readWatermark = (db: WachiDb, destinationId: number, rssUrl: string): number | null => {
  const value = getMetaValue(db, watermarkKey(destinationId, rssUrl));
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const itemTimestamp = (item: SubscriptionItem): number | null => {
  if (!item.publishedAt) {
    return null;
  }
  const parsed = Date.parse(item.publishedAt);
  return Number.isNaN(parsed) ? null : parsed;
};

const latestTimestamp = (items: SubscriptionItem[]): number | null => {
  let latest: number | null = null;
  for (const item of items) {
    const timestamp = itemTimestamp(item);
    if (timestamp !== null && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
};

const isKnownItem = (db: WachiDb, destinationId: number, item: SubscriptionItem): boolean => {
  try {
    return hasDeliveryKey(db, destinationId, buildLinkKey(item.link));
  } catch {
    return false;
  }
};

const continuityError = (rssUrl: string, itemCount: number): WachiError =>
  new WachiError(
    `Feed continuity lost for ${rssUrl}`,
    `The established feed returned ${itemCount} items without a previously seen anchor or an item newer than its saved publication watermark.`,
    "Verify that the feed still represents the same chronological stream. Historical backfills must be subscribed explicitly with --send-existing.",
  );

export const markFeedBackfillPending = (
  db: WachiDb,
  destinationId: number,
  rssUrl: string,
): void => {
  setMetaValue(db, backfillKey(destinationId, rssUrl), "1");
};

export const selectContinuousFeedItems = ({
  db,
  destinationId,
  rssUrl,
  items,
  cutoverComplete,
}: {
  db: WachiDb;
  destinationId: number;
  rssUrl: string;
  items: SubscriptionItem[];
  cutoverComplete: boolean;
}): FeedContinuitySelection => {
  if (
    !cutoverComplete ||
    getMetaValue(db, backfillKey(destinationId, rssUrl)) === "1" ||
    items.length === 0
  ) {
    return { baselineItems: [], deliveryItems: items };
  }

  const knownItems = items.filter((item) => isKnownItem(db, destinationId, item));
  const watermark = readWatermark(db, destinationId, rssUrl);
  if (knownItems.length > 0) {
    const knownTimestamp = latestTimestamp(knownItems);
    const threshold =
      watermark === null
        ? knownTimestamp
        : knownTimestamp === null
          ? watermark
          : Math.max(watermark, knownTimestamp);
    const baselineItems: SubscriptionItem[] = [];
    const deliveryItems: SubscriptionItem[] = [];

    for (const item of items) {
      const timestamp = itemTimestamp(item);
      if (
        isKnownItem(db, destinationId, item) ||
        (timestamp !== null && threshold !== null && timestamp <= threshold)
      ) {
        baselineItems.push(item);
      } else {
        // Undated feeds cannot be ordered reliably, so preserve their prior
        // delivery behavior once a known item proves feed continuity.
        deliveryItems.push(item);
      }
    }
    return { baselineItems, deliveryItems };
  }

  if (watermark !== null) {
    const baselineItems: SubscriptionItem[] = [];
    const deliveryItems: SubscriptionItem[] = [];
    for (const item of items) {
      const timestamp = itemTimestamp(item);
      if (timestamp !== null && timestamp > watermark) {
        deliveryItems.push(item);
      } else {
        baselineItems.push(item);
      }
    }
    if (deliveryItems.length > 0) {
      return { baselineItems, deliveryItems };
    }
  }

  throw continuityError(rssUrl, items.length);
};

export const recordFeedContinuity = (
  db: WachiDb,
  destinationId: number,
  rssUrl: string,
  items: SubscriptionItem[],
): void => {
  const previous = readWatermark(db, destinationId, rssUrl);
  const latest = latestTimestamp(items);
  if (latest !== null && (previous === null || latest > previous)) {
    setMetaValue(db, watermarkKey(destinationId, rssUrl), new Date(latest).toISOString());
  }
  deleteMetaValue(db, backfillKey(destinationId, rssUrl));
};
