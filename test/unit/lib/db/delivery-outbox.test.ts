import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import {
  admitDeliveryKey,
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
  rehomeQueuedDelivery,
} from "../../../../src/lib/db/delivery-outbox.ts";
import { deliveryOutbox } from "../../../../src/lib/db/schema.ts";

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
    const claimed = claimNextDelivery(db, destinationId, {
      now: 100,
      leaseDurationMs: 100,
    });
    if (!claimed) {
      throw new Error("delivery was not claimed");
    }

    expect(markDeliveryRetry(db, claimed, "offline", 50, 100)).toBe(true);
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
    const claimed = claimNextDelivery(db, destinationId, { now: 0, leaseDurationMs: 100 });
    if (!claimed) {
      throw new Error("delivery was not claimed");
    }
    markDeliveryDispatching(db, claimed);

    expect(markDeliveryRetry(db, claimed, "rejected", 10, 0)).toBe(true);
    const retried = claimNextDelivery(db, destinationId, { now: 10 });
    expect(retried?.state).toBe("reserved");
    expect(retried?.attempts).toBe(2);
  });

  it("recovers an existing uncertain delivery", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    db.update(deliveryOutbox)
      .set({ state: "uncertain", lastError: "legacy ambiguous result" })
      .run();

    const recovered = claimNextDelivery(db, destinationId, { now: 100_000 });
    expect(recovered?.linkKey).toEqual(key(2));
    expect(recovered?.state).toBe("reserved");
    expect(recovered?.attempts).toBe(1);
  });

  it("completes success by deleting only the outbox record", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    const claimed = claimNextDelivery(db, destinationId, { now: 0 });
    if (!claimed) {
      throw new Error("delivery was not claimed");
    }

    expect(markDeliveryDispatching(db, claimed)).toBe(true);
    expect(completeDeliverySuccess(db, claimed)).toBe(true);
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

  it("rehomes a queued delivery when the target already has a baseline key", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const oldDestinationId = resolveDestinationId(db, key(1));
    const newDestinationId = resolveDestinationId(db, key(2));
    const linkKey = key(3);
    admit(oldDestinationId, linkKey, 100);
    expect(admitDeliveryKey(db, newDestinationId, linkKey)).toBe(true);
    const queued = listDeliveryOutbox(db, oldDestinationId)[0];
    if (!queued) {
      throw new Error("delivery was not queued");
    }

    expect(rehomeQueuedDelivery(db, queued, newDestinationId)).toBe(true);

    expect(listDeliveryOutbox(db, oldDestinationId)).toHaveLength(0);
    expect(listDeliveryOutbox(db, newDestinationId)).toMatchObject([
      { payload: `payload-${linkKey[0]}`, linkKey },
    ]);
  });

  it("fences a stale worker after its delivery is reclaimed", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    const stale = claimNextDelivery(db, destinationId, {
      now: 0,
      leaseDurationMs: 10,
      claimOwner: "worker-a",
    });
    const current = claimNextDelivery(db, destinationId, {
      now: 10,
      leaseDurationMs: 10,
      claimOwner: "worker-b",
    });
    if (!stale || !current) {
      throw new Error("delivery was not claimed");
    }

    expect(current.claimGeneration).toBe(stale.claimGeneration + 1);
    expect(markDeliveryDispatching(db, { ...current, claimOwner: stale.claimOwner })).toBe(false);
    expect(
      markDeliveryDispatching(db, { ...current, claimGeneration: stale.claimGeneration }),
    ).toBe(false);
    expect(markDeliveryDispatching(db, stale)).toBe(false);
    expect(markDeliveryRetry(db, stale, "stale failure", 0, 10)).toBe(false);
    expect(completeDeliverySuccess(db, stale)).toBe(false);
    expect(markDeliveryDispatching(db, current)).toBe(true);
    expect(completeDeliverySuccess(db, current)).toBe(true);
  });

  it("recovers an expired reservation to pending and retries it", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    const claimed = claimNextDelivery(db, destinationId, { now: 100, leaseDurationMs: 10 });
    if (!claimed) {
      throw new Error("delivery was not claimed");
    }

    const recovered = claimNextDelivery(db, destinationId, { now: 110, leaseDurationMs: 10 });

    expect(recovered?.linkKey).toEqual(key(2));
    expect(recovered?.state).toBe("reserved");
    expect(recovered?.attempts).toBe(2);
  });

  it("recovers an expired dispatch for another delivery attempt", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(destinationId, key(2), 0);
    admit(destinationId, key(3), 1);
    const claimed = claimNextDelivery(db, destinationId, { now: 100, leaseDurationMs: 10 });
    if (!claimed) {
      throw new Error("delivery was not claimed");
    }
    markDeliveryDispatching(db, claimed);

    const next = claimNextDelivery(db, destinationId, { now: 110, leaseDurationMs: 10 });
    const records = listDeliveryOutbox(db, destinationId);

    expect(next?.linkKey).toEqual(key(2));
    expect(next?.attempts).toBe(2);
    expect(records.find((record) => record.linkKey.equals(key(2)))?.state).toBe("reserved");
    expect(records.find((record) => record.linkKey.equals(key(3)))?.state).toBe("pending");
  });
});
