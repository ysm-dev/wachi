import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainDestinationOutbox } from "../../../../src/lib/check/drain-outbox.ts";
import { handleSubscriptionItems } from "../../../../src/lib/check/handle-items.ts";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import {
  admitDeliveryWithOutbox,
  listDeliveryKeys,
  resolveDestinationId,
} from "../../../../src/lib/db/delivery-ledger.ts";
import { claimNextDelivery, listDeliveryOutbox } from "../../../../src/lib/db/delivery-outbox.ts";
import { serializeDeliverySource } from "../../../../src/lib/notify/delivery-source.ts";
import { resetSendNotificationStateForTest } from "../../../../src/lib/notify/send.ts";

type Db = ConnectedDb["db"];
type AppriseOutcome = "success" | "undelivered" | "spawn-error";

const key = (value: number): Buffer => Buffer.alloc(32, value);

const makeStream = (text: string): ReadableStream<Uint8Array> => {
  return new Response(text).body as ReadableStream<Uint8Array>;
};

const originalSpawn = Bun.spawn;
const originalNoArchive = process.env.WACHI_NO_ARCHIVE;

let appriseOutcome: AppriseOutcome = "success";
const dispatchedBodies: string[] = [];

let tempDir = "";
let connection: ConnectedDb | null = null;

// Mock the notification subprocess: any non-apprise invocation (the uvx runtime
// probe) succeeds; the apprise send returns the configured outcome. This
// exercises the real send.ts classification without touching the network and
// without leaking module mocks across test files.
const installSpawnMock = (): void => {
  Bun.spawn = ((command: string[]) => {
    if (!command.includes("apprise")) {
      return { exited: Promise.resolve(0), kill: () => {} };
    }

    dispatchedBodies.push(command[3] ?? "");
    if (appriseOutcome === "spawn-error") {
      throw new Error("failed to spawn apprise");
    }
    if (appriseOutcome === "undelivered") {
      return {
        exited: Promise.resolve(1),
        stdout: makeStream(""),
        stderr: makeStream("apprise rejected the webhook"),
        kill: () => {},
      };
    }
    return {
      exited: Promise.resolve(0),
      stdout: makeStream(""),
      stderr: makeStream(""),
      kill: () => {},
    };
  }) as unknown as typeof Bun.spawn;
};

const makeStats = () => ({
  sent: [] as Array<{ title: string; link: string; channel_name: string }>,
  skipped: 0,
  errors: [] as string[],
  networkSkipped: 0,
});

const admit = (db: Db, destinationId: number, n: number): void => {
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
  appriseOutcome = "success";
  process.env.WACHI_NO_ARCHIVE = "1";
  resetSendNotificationStateForTest();
  installSpawnMock();
});

afterEach(async () => {
  Bun.spawn = originalSpawn;
  resetSendNotificationStateForTest();
  if (originalNoArchive === undefined) {
    delete process.env.WACHI_NO_ARCHIVE;
  } else {
    process.env.WACHI_NO_ARCHIVE = originalNoArchive;
  }
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

  it("delivers payloads even when nonessential source metadata is corrupted", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admitDeliveryWithOutbox(db, {
      destinationId,
      linkKey: key(2),
      payload: "must-deliver",
      source: "not-json",
      link: "https://example.com/must-deliver",
    });

    const stats = await drain(db, destinationId);

    expect(dispatchedBodies).toEqual(["must-deliver"]);
    expect(stats.sent).toEqual([
      {
        title: "https://example.com/must-deliver",
        link: "https://example.com/must-deliver",
        channel_name: "unknown",
      },
    ]);
    expect(listDeliveryOutbox(db, destinationId)).toHaveLength(0);
  });

  it("retries a determinate failure that happened after dispatch began", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(db, destinationId, 2);
    appriseOutcome = "undelivered";

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

  it("retries indefinitely without exhausting the delivery", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(db, destinationId, 2);
    appriseOutcome = "undelivered";

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await drain(db, destinationId);
    }

    const rows = listDeliveryOutbox(db, destinationId);
    expect(rows[0]?.state).toBe("pending");
    expect(rows[0]?.attempts).toBe(10);
    expect(claimNextDelivery(db, destinationId)).toBeDefined();
  });

  it("retries when the apprise process cannot be spawned", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const destinationId = resolveDestinationId(db, key(1));
    admit(db, destinationId, 2);
    appriseOutcome = "spawn-error";

    const stats = await drain(db, destinationId);

    expect(stats.sent).toEqual([]);
    expect(stats.errors).toHaveLength(1);
    expect(listDeliveryOutbox(db, destinationId)[0]).toMatchObject({
      state: "pending",
      attempts: 1,
      leaseExpiresAt: null,
      claimOwner: null,
    });
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
