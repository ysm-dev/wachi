import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDedupHash } from "../../../../src/lib/db/build-dedup-hash.ts";
import { cleanupSentItems } from "../../../../src/lib/db/cleanup-sent-items.ts";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import { sentItems } from "../../../../src/lib/db/schema.ts";

let tempDir = "";
let connection: ConnectedDb | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-db-cleanup-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
});

afterEach(async () => {
  connection?.sqlite.close();
  connection = null;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

const insertSentItem = async (offsetDays: number, title: string): Promise<void> => {
  const db = connection?.db;
  if (!db) {
    throw new Error("db not initialized");
  }

  const channelUrl = "slack://token";
  const link = `https://example.com/${title.toLowerCase()}`;

  db.insert(sentItems)
    .values({
      dedupHash: buildDedupHash(channelUrl, title, link),
      channelUrl,
      subscriptionUrl: "https://example.com",
      title,
      link,
      sentAt: new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString(),
    })
    .run();
};

describe("cleanupSentItems", () => {
  it("deletes records older than ttl", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    await insertSentItem(10, "Old");
    await insertSentItem(0, "New");

    const result = cleanupSentItems(db, 7, 50_000);

    expect(result.deletedByTtl).toBe(1);
    expect(result.deletedByCap).toBe(0);
  });

  it("caps records to maxRecords by deleting oldest entries", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    await insertSentItem(3, "Oldest");
    await insertSentItem(2, "Middle");
    await insertSentItem(1, "Newest");

    const result = cleanupSentItems(db, 365, 2);

    expect(result.deletedByTtl).toBe(0);
    expect(result.deletedByCap).toBe(1);
  });

  it("returns without cap deletion when oldest id list is empty", () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          get: () => ({ count: 5 }),
          orderBy: () => ({
            limit: () => ({
              all: () => [{ id: null }],
            }),
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          run: () => undefined,
        }),
      }),
    };

    const db = fakeDb as unknown as Parameters<typeof cleanupSentItems>[0];
    const result = cleanupSentItems(db, 365, 1);

    expect(result.deletedByTtl).toBe(0);
    expect(result.deletedByCap).toBe(0);
  });
});
