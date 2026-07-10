import { eq } from "drizzle-orm";
import { sha256 } from "../../utils/hash.ts";
import { toChannelNameKey } from "../config/channel-name-key.ts";
import type { WachiDb } from "../db/connect.ts";
import { admitDeliveryKeys } from "../db/delivery-ledger.ts";
import { getMetaValue } from "../db/get-meta-value.ts";
import { sentItems } from "../db/schema.ts";
import { setMetaValue } from "../db/set-meta-value.ts";
import { buildLinkKey } from "../subscriptions/item-identity.ts";

const CUTOVER_VERSION = 1;

const cutoverMarkerKey = (destinationId: number, rssUrl: string): string => {
  return `delivery-cutover:v${CUTOVER_VERSION}:${destinationId}:${sha256(rssUrl)}`;
};

export const hasDeliveryCutover = (db: WachiDb, destinationId: number, rssUrl: string): boolean => {
  return getMetaValue(db, cutoverMarkerKey(destinationId, rssUrl)) === "1";
};

export const markDeliveryCutover = (db: WachiDb, destinationId: number, rssUrl: string): void => {
  setMetaValue(db, cutoverMarkerKey(destinationId, rssUrl), "1");
};

export const backfillLegacyDeliveryKeys = (
  db: WachiDb,
  destinationId: number,
  channelName: string,
): number => {
  const marker = `legacy-delivery-backfill:v${CUTOVER_VERSION}:${destinationId}:${toChannelNameKey(channelName)}`;
  if (getMetaValue(db, marker) === "1") {
    return 0;
  }

  const rows = db
    .select({ link: sentItems.link })
    .from(sentItems)
    .where(eq(sentItems.channelUrl, channelName))
    .all();
  const keys = rows.flatMap((row) => {
    if (!row.link) {
      return [];
    }
    try {
      return [buildLinkKey(row.link)];
    } catch {
      return [];
    }
  });
  const inserted = admitDeliveryKeys(db, destinationId, keys);
  setMetaValue(db, marker, "1");
  return inserted;
};
