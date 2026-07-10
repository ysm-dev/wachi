import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import {
  admitDeliveryKey,
  admitDeliveryWithOutbox,
  listDeliveryKeys,
  listDestinations,
  resolveDestinationId,
} from "../../../../src/lib/db/delivery-ledger.ts";
import { listDeliveryOutbox } from "../../../../src/lib/db/delivery-outbox.ts";

let tempDir = "";
let connection: ConnectedDb | null = null;

const key = (value: number): Buffer => Buffer.alloc(32, value);

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-db-delivery-ledger-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
});

afterEach(async () => {
  connection?.sqlite.close();
  connection = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe("delivery ledger", () => {
  it("resolves one destination ID for equal Buffer and Uint8Array keys", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationKey = key(1);

    const first = resolveDestinationId(db, destinationKey);
    const second = resolveDestinationId(db, new Uint8Array(destinationKey));

    expect(second).toBe(first);
    expect(listDestinations(db)).toHaveLength(1);
  });

  it("admits baseline keys once without creating outbox records", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));

    expect(admitDeliveryKey(db, destinationId, key(2))).toBe(true);
    expect(admitDeliveryKey(db, destinationId, key(2))).toBe(false);
    expect(listDeliveryKeys(db, destinationId)).toHaveLength(1);
    expect(listDeliveryOutbox(db, destinationId)).toHaveLength(0);
  });

  it("atomically admits a permanent key and its outbox record once", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    const admission = {
      destinationId,
      linkKey: key(2),
      payload: "payload-json",
      source: "https://example.com/feed",
      link: "https://example.com/item",
      availableAt: 100,
    };

    expect(admitDeliveryWithOutbox(db, admission)).toBe(true);
    expect(admitDeliveryWithOutbox(db, admission)).toBe(false);

    expect(listDeliveryKeys(db, destinationId)).toHaveLength(1);
    const outbox = listDeliveryOutbox(db, destinationId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      destinationId,
      linkKey: key(2),
      payload: "payload-json",
      source: "https://example.com/feed",
      link: "https://example.com/item",
      state: "pending",
      attempts: 0,
      availableAt: 100,
      leaseExpiresAt: null,
      lastError: null,
    });
    expect(typeof outbox[0]?.enqueuedSeq).toBe("number");
  });

  it("rejects keys that are not 32 bytes", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    expect(() => resolveDestinationId(db, Buffer.alloc(31))).toThrow("exactly 32 bytes");
  });

  it("enforces one delivery key across independent database connections", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const second = await connectDb(join(tempDir, "wachi.db"));
    try {
      const destinationKey = key(8);
      const firstDestinationId = resolveDestinationId(db, destinationKey);
      const secondDestinationId = resolveDestinationId(second.db, destinationKey);

      expect(secondDestinationId).toBe(firstDestinationId);
      expect(admitDeliveryKey(db, firstDestinationId, key(9))).toBe(true);
      expect(admitDeliveryKey(second.db, secondDestinationId, key(9))).toBe(false);
      expect(listDeliveryKeys(second.db, secondDestinationId)).toHaveLength(1);
    } finally {
      second.sqlite.close();
    }
  });
});
