import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markFeedBackfillPending,
  recordFeedContinuity,
  selectContinuousFeedItems,
} from "../../../../src/lib/check/feed-continuity.ts";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import { admitDeliveryKey, resolveDestinationId } from "../../../../src/lib/db/delivery-ledger.ts";
import { buildDestinationKey } from "../../../../src/lib/notify/destination-identity.ts";
import { buildLinkKey } from "../../../../src/lib/subscriptions/item-identity.ts";
import type { SubscriptionItem } from "../../../../src/lib/subscriptions/subscription-item.ts";

const rssUrl = "https://example.com/feed.xml";
const item = (name: string, publishedAt: string | null): SubscriptionItem => ({
  title: name,
  link: `https://example.com/${name}`,
  publishedAt,
});

let tempDir = "";
let connection: ConnectedDb | null = null;
let destinationId = 0;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-feed-continuity-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
  destinationId = resolveDestinationId(connection.db, buildDestinationKey("discord://1234/token"));
});

afterEach(async () => {
  connection?.sqlite.close();
  connection = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe("feed continuity", () => {
  it("delivers only items after the newest known anchor", () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    const oldBackfill = item("old-backfill", "2026-01-01T00:00:00.000Z");
    const anchor = item("anchor", "2026-02-01T00:00:00.000Z");
    const newest = item("newest", "2026-03-01T00:00:00.000Z");
    admitDeliveryKey(db, destinationId, buildLinkKey(anchor.link));

    const selected = selectContinuousFeedItems({
      db,
      destinationId,
      rssUrl,
      items: [oldBackfill, anchor, newest],
      cutoverComplete: true,
    });

    expect(selected.baselineItems).toEqual([oldBackfill, anchor]);
    expect(selected.deliveryItems).toEqual([newest]);
  });

  it("preserves unknown items in an undated feed with a known anchor", () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    const newest = item("newest", null);
    const anchor = item("anchor", null);
    admitDeliveryKey(db, destinationId, buildLinkKey(anchor.link));

    const selected = selectContinuousFeedItems({
      db,
      destinationId,
      rssUrl,
      items: [newest, anchor],
      cutoverComplete: true,
    });

    expect(selected.baselineItems).toEqual([anchor]);
    expect(selected.deliveryItems).toEqual([newest]);
  });

  it("rejects an established feed containing only items older than its watermark", () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    recordFeedContinuity(db, destinationId, rssUrl, [item("previous", "2026-08-01T00:00:00.000Z")]);

    expect(() =>
      selectContinuousFeedItems({
        db,
        destinationId,
        rssUrl,
        items: [
          item("historical-1", "2025-01-01T00:00:00.000Z"),
          item("historical-2", "2025-02-01T00:00:00.000Z"),
        ],
        cutoverComplete: true,
      }),
    ).toThrow("Feed continuity lost");
  });

  it("accepts a fully rotated feed when dated items advance the watermark", () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    recordFeedContinuity(db, destinationId, rssUrl, [item("previous", "2026-08-01T00:00:00.000Z")]);
    const historical = item("historical", "2025-01-01T00:00:00.000Z");
    const firstNew = item("first-new", "2026-08-02T00:00:00.000Z");
    const secondNew = item("second-new", "2026-08-03T00:00:00.000Z");

    const selected = selectContinuousFeedItems({
      db,
      destinationId,
      rssUrl,
      items: [historical, firstNew, secondNew],
      cutoverComplete: true,
    });

    expect(selected.baselineItems).toEqual([historical]);
    expect(selected.deliveryItems).toEqual([firstNew, secondNew]);
  });

  it("preserves the explicit send-existing backfill", () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    const items = [item("old", null), item("new", null)];
    markFeedBackfillPending(db, destinationId, rssUrl);

    expect(
      selectContinuousFeedItems({
        db,
        destinationId,
        rssUrl,
        items,
        cutoverComplete: true,
      }),
    ).toEqual({ baselineItems: [], deliveryItems: items });
  });
});
