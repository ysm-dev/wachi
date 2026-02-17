import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDedupHash } from "../../../../src/lib/db/build-dedup-hash.ts";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import { hasDedupHash } from "../../../../src/lib/db/has-dedup-hash.ts";
import { insertDedupRecord } from "../../../../src/lib/db/insert-dedup-record.ts";
import { seedDedupRecords } from "../../../../src/lib/db/seed-dedup-records.ts";

let tempDir = "";
let connection: ConnectedDb | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-db-dedup-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
});

afterEach(async () => {
  connection?.sqlite.close();
  connection = null;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("dedup db operations", () => {
  it("buildDedupHash is deterministic", () => {
    const first = buildDedupHash("slack://token", "Post", "https://example.com/post");
    const second = buildDedupHash("slack://token", "Post", "https://example.com/post");
    expect(first).toBe(second);
  });

  it("insertDedupRecord inserts once per dedup hash", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const first = insertDedupRecord(db, {
      channelUrl: "slack://token",
      subscriptionUrl: "https://example.com",
      title: "Post",
      link: "https://example.com/post",
    });
    const second = insertDedupRecord(db, {
      channelUrl: "slack://token",
      subscriptionUrl: "https://example.com",
      title: "Post",
      link: "https://example.com/post",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("hasDedupHash returns true for inserted hash", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const hash = buildDedupHash("slack://token", "Post", "https://example.com/post");
    insertDedupRecord(db, {
      channelUrl: "slack://token",
      subscriptionUrl: "https://example.com",
      title: "Post",
      link: "https://example.com/post",
    });

    expect(hasDedupHash(db, hash)).toBe(true);
  });

  it("seedDedupRecords returns inserted unique count", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const count = seedDedupRecords(db, "slack://token", "https://example.com", [
      { title: "A", link: "https://example.com/a" },
      { title: "A", link: "https://example.com/a" },
      { title: "B", link: "https://example.com/b" },
    ]);

    expect(count).toBe(2);
  });
});
