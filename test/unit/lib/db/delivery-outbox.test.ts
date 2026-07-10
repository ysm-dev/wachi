import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import {
  admitDeliveryWithOutbox,
  listDeliveryKeys,
  resolveDestinationId,
} from "../../../../src/lib/db/delivery-ledger.ts";
import {
  claimNextDelivery,
  completeDeliverySuccess,
  listDeliveryOutbox,
  markDeliveryDispatching,
  markDeliveryRetry,
  markDeliveryUncertain,
} from "../../../../src/lib/db/delivery-outbox.ts";

let tempDir = "";
let connection: ConnectedDb | null = null;

const key = (value: number): Buffer => Buffer.alloc(32, value);

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-db-delivery-outbox-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
});

afterEach(async () => {
  connection?.sqlite.close();
  connection = null;
  await rm(tempDir, { recursive: true, force: true });
});

const admit = (destinationId: number, linkKey: Buffer, availableAt: number): void => {
  const db = connection?.db;
  if (!db) {
    throw new Error("db not initialized");
  }
  const accepted = admitDeliveryWithOutbox(db, {
    destinationId,
    linkKey,
    payload: `payload-${linkKey[0]}`,
    source: "source",
    link: `https://example.com/${linkKey[0]}`,
    availableAt,
  });
  if (!accepted) {
    throw new Error("delivery was not accepted");
  }
};

describe("delivery outbox", () => {
  it("claims the oldest available pending record and allows one active row per destination", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 200);
    admit(destinationId, key(3), 100);

    const claimed = claimNextDelivery(db, destinationId, { now: 200, leaseDurationMs: 50 });

    expect(claimed?.linkKey).toEqual(key(3));
    expect(claimed?.state).toBe("reserved");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseExpiresAt).toBe(250);
    expect(claimNextDelivery(db, destinationId, { now: 200 })).toBeUndefined();
  });

  it("returns a reserved failure to pending with backoff", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 100);
    claimNextDelivery(db, destinationId, { now: 100, leaseDurationMs: 100 });

    expect(markDeliveryRetry(db, destinationId, key(2), "offline", 50, 100)).toBe(true);
    expect(claimNextDelivery(db, destinationId, { now: 149 })).toBeUndefined();
    const retried = claimNextDelivery(db, destinationId, { now: 150 });
    expect(retried?.state).toBe("reserved");
    expect(retried?.attempts).toBe(2);
    expect(retried?.lastError).toBeNull();
  });

  it("retries a determinate failure that occurred after dispatch began", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    claimNextDelivery(db, destinationId, { now: 0, leaseDurationMs: 100 });
    markDeliveryDispatching(db, destinationId, key(2));

    expect(markDeliveryRetry(db, destinationId, key(2), "rejected", 10, 0)).toBe(true);
    const retried = claimNextDelivery(db, destinationId, { now: 10 });
    expect(retried?.state).toBe("reserved");
    expect(retried?.attempts).toBe(2);
  });

  it("parks a reserved delivery as uncertain when it cannot be dispatched", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    claimNextDelivery(db, destinationId, { now: 0 });

    expect(markDeliveryUncertain(db, destinationId, key(2), "corrupt payload")).toBe(true);
    expect(listDeliveryOutbox(db, destinationId)[0]?.state).toBe("uncertain");
    expect(claimNextDelivery(db, destinationId, { now: 100_000 })).toBeUndefined();
  });

  it("completes success by deleting only the outbox record", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    claimNextDelivery(db, destinationId, { now: 0 });

    expect(markDeliveryDispatching(db, destinationId, key(2))).toBe(true);
    expect(completeDeliverySuccess(db, destinationId, key(2))).toBe(true);
    expect(listDeliveryOutbox(db, destinationId)).toHaveLength(0);
    expect(listDeliveryKeys(db, destinationId)).toHaveLength(1);
    expect(
      admitDeliveryWithOutbox(db, {
        destinationId,
        linkKey: key(2),
        payload: "duplicate",
        source: "source",
        link: "link",
      }),
    ).toBe(false);
  });

  it("marks a dispatch with an unknown outcome as uncertain", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    claimNextDelivery(db, destinationId, { now: 0 });
    markDeliveryDispatching(db, destinationId, key(2));

    expect(markDeliveryUncertain(db, destinationId, key(2), "connection lost")).toBe(true);
    expect(listDeliveryOutbox(db, destinationId)[0]).toMatchObject({
      state: "uncertain",
      leaseExpiresAt: null,
      lastError: "connection lost",
    });
    expect(claimNextDelivery(db, destinationId, { now: 100_000 })).toBeUndefined();
  });

  it("recovers an expired reservation to pending and retries it", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    claimNextDelivery(db, destinationId, { now: 100, leaseDurationMs: 10 });

    const recovered = claimNextDelivery(db, destinationId, { now: 110, leaseDurationMs: 10 });

    expect(recovered?.linkKey).toEqual(key(2));
    expect(recovered?.state).toBe("reserved");
    expect(recovered?.attempts).toBe(2);
  });

  it("recovers an expired dispatch as uncertain before claiming the next row", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    admit(destinationId, key(3), 1);
    claimNextDelivery(db, destinationId, { now: 100, leaseDurationMs: 10 });
    markDeliveryDispatching(db, destinationId, key(2));

    const next = claimNextDelivery(db, destinationId, { now: 110, leaseDurationMs: 10 });
    const records = listDeliveryOutbox(db, destinationId);

    expect(next?.linkKey).toEqual(key(3));
    expect(records.find((record) => record.linkKey.equals(key(2)))?.state).toBe("uncertain");
    expect(records.find((record) => record.linkKey.equals(key(3)))?.state).toBe("reserved");
  });
});
