import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import { getMetaValue } from "../../../../src/lib/db/get-meta-value.ts";
import { setMetaValue } from "../../../../src/lib/db/set-meta-value.ts";

let tempDir = "";
let connection: ConnectedDb | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-db-meta-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
});

afterEach(async () => {
  connection?.sqlite.close();
  connection = null;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("meta db operations", () => {
  it("returns null for missing keys", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    expect(getMetaValue(db, "missing")).toBeNull();
  });

  it("sets and updates values", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    setMetaValue(db, "etag:https://example.com/feed.xml", '"abc"');
    expect(getMetaValue(db, "etag:https://example.com/feed.xml")).toBe('"abc"');

    setMetaValue(db, "etag:https://example.com/feed.xml", '"def"');
    expect(getMetaValue(db, "etag:https://example.com/feed.xml")).toBe('"def"');
  });

  it("returns null when stored row shape is invalid", () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              get: () => ({ key: "etag:https://example.com/feed.xml", value: 123 }),
            }),
          }),
        }),
      }),
    };

    const db = fakeDb as unknown as Parameters<typeof getMetaValue>[0];
    expect(getMetaValue(db, "etag:https://example.com/feed.xml")).toBeNull();
  });
});
