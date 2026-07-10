import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectedDb } from "../../../../src/lib/db/connect.ts";

const sendModulePath = new URL("../../../../src/lib/notify/send.ts", import.meta.url).pathname;
const archiveModulePath = new URL("../../../../src/lib/archive/submit.ts", import.meta.url)
  .pathname;

type DeliveryFailureOutcome = "undelivered" | "unknown";

class FakeDeliveryError extends Error {
  readonly outcome: DeliveryFailureOutcome;
  constructor(outcome: DeliveryFailureOutcome, message: string) {
    super(message);
    this.name = "NotificationDeliveryError";
    this.outcome = outcome;
  }
}

type SendCall = { onDispatchStart?: () => void | Promise<void>; body: string };

let sendBehavior: (call: SendCall) => Promise<void> = async (call) => {
  await call.onDispatchStart?.();
};
const dispatchedBodies: string[] = [];

mock.module(sendModulePath, () => ({
  NotificationDeliveryError: FakeDeliveryError,
  sendNotification: async (call: SendCall) => {
    dispatchedBodies.push(call.body);
    return sendBehavior(call);
  },
}));

mock.module(archiveModulePath, () => ({
  submitArchive: () => {},
}));

const { drainDestinationOutbox } = await import("../../../../src/lib/check/drain-outbox.ts");
const { handleSubscriptionItems } = await import("../../../../src/lib/check/handle-items.ts");
const { connectDb } = await import("../../../../src/lib/db/connect.ts");
const { admitDeliveryWithOutbox, listDeliveryKeys, resolveDestinationId } = await import(
  "../../../../src/lib/db/delivery-ledger.ts"
);
const { claimNextDelivery, listDeliveryOutbox } = await import(
  "../../../../src/lib/db/delivery-outbox.ts"
);
const { serializeDeliverySource } = await import("../../../../src/lib/notify/delivery-source.ts");

type Db = ConnectedDb["db"];

const key = (value: number): Buffer => Buffer.alloc(32, value);

let tempDir = "";
let connection: ConnectedDb | null = null;

const makeStats = () => ({
  sent: [] as Array<{ title: string; link: string; channel_name: string }>,
  skipped: 0,
  errors: [] as string[],
  networkSkipped: 0,
});

const admit = (db: Db, destinationId: number, n: number, availableAt = 0): void => {
  admitDeliveryWithOutbox(db, {
    destinationId,
    linkKey: key(n),
    payload: `body-${n}`,
    source: serializeDeliverySource({
      channelName: "main",
      subscriptionUrl: "https://example.com/feed",
      title: `Item ${n}`,
      archiveLink: `https://example.com/${n}`,
    }),
    link: `https://example.com/${n}`,
    availableAt,
  });
};

const drain = async (db: Db, destinationId: number) => {
  const stats = makeStats();
  await drainDestinationOutbox({
    db,
    destinationId,
    effectiveChannelUrl: "slack://token/channel",
    isJson: true,
    isVerbose: false,
    stats,
  });
  return stats;
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-drain-outbox-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
  dispatchedBodies.length = 0;
  sendBehavior = async (call) => {
    await call.onDispatchStart?.();
  };
});

afterEach(async () => {
  connection?.sqlite.close();
  connection = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe("drainDestinationOutbox", () => {
  it("delivers a pending item and keeps only the permanent key", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(db, destinationId, 2);

    const stats = await drain(db, destinationId);

    expect(stats.sent).toHaveLength(1);
    expect(stats.errors).toEqual([]);
    expect(listDeliveryOutbox(db, destinationId)).toHaveLength(0);
    expect(listDeliveryKeys(db, destinationId)).toHaveLength(1);
  });

  it("retries a determinate failure that happened after dispatch began", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(db, destinationId, 2);
    sendBehavior = async (call) => {
      await call.onDispatchStart?.();
      throw new FakeDeliveryError("undelivered", "apprise exited non-zero");
    };

    const stats = await drain(db, destinationId);

    expect(stats.sent).toEqual([]);
    expect(stats.errors).toHaveLength(1);
    const rows = listDeliveryOutbox(db, destinationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("pending");
    // Retryable immediately: the next check can claim it again.
    expect(claimNextDelivery(db, destinationId)).toBeDefined();
    // The permanent key is retained regardless of outcome.
    expect(listDeliveryKeys(db, destinationId)).toHaveLength(1);
  });

  it("parks an ambiguous outcome as uncertain and never retries it", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(db, destinationId, 2);
    sendBehavior = async (call) => {
      await call.onDispatchStart?.();
      throw new FakeDeliveryError("unknown", "apprise timed out");
    };

    const stats = await drain(db, destinationId);

    expect(stats.errors).toHaveLength(1);
    const rows = listDeliveryOutbox(db, destinationId);
    expect(rows[0]?.state).toBe("uncertain");
    expect(claimNextDelivery(db, destinationId, { now: 10_000_000 })).toBeUndefined();
    expect(listDeliveryKeys(db, destinationId)).toHaveLength(1);
  });

  it("parks a determinate failure as uncertain once retries are exhausted", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(db, destinationId, 2);
    sendBehavior = async (call) => {
      await call.onDispatchStart?.();
      throw new FakeDeliveryError("undelivered", "apprise exited non-zero");
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await drain(db, destinationId);
    }

    const rows = listDeliveryOutbox(db, destinationId);
    expect(rows[0]?.state).toBe("uncertain");
    expect(claimNextDelivery(db, destinationId, { now: 10_000_000 })).toBeUndefined();
  });

  it("delivers admitted items in oldest-first order", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    const stats = makeStats();
    // handleSubscriptionItems receives items oldest-first.
    await handleSubscriptionItems({
      items: [
        { title: "Oldest", link: "https://example.com/oldest" },
        { title: "Middle", link: "https://example.com/middle" },
        { title: "Newest", link: "https://example.com/newest" },
      ],
      channelName: "main",
      destinationId,
      subscriptionUrl: "https://example.com/feed",
      db,
      dryRun: false,
      baseline: false,
      isJson: true,
      isVerbose: false,
      stats,
      sourceIdentity: undefined,
      linkTransforms: [],
    });

    await drain(db, destinationId);

    expect(dispatchedBodies).toHaveLength(3);
    expect(dispatchedBodies[0]).toContain("https://example.com/oldest");
    expect(dispatchedBodies[1]).toContain("https://example.com/middle");
    expect(dispatchedBodies[2]).toContain("https://example.com/newest");
  });
});
