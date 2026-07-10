import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushArchivePool, resetArchivePoolForTest } from "../../src/lib/archive/pool.ts";
import { drainDestinationOutbox } from "../../src/lib/check/drain-outbox.ts";
import type { CheckStats } from "../../src/lib/check/handle-items.ts";
import { handleSubscriptionItems } from "../../src/lib/check/handle-items.ts";
import { type ConnectedDb, connectDb } from "../../src/lib/db/connect.ts";
import { resolveDestinationId } from "../../src/lib/db/delivery-ledger.ts";
import { buildDestinationKey } from "../../src/lib/notify/destination-identity.ts";
import { resetSendNotificationStateForTest } from "../../src/lib/notify/send.ts";

type MockProc = {
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  kill: () => void;
};

type CapturedRequest = {
  method: string;
  url: string;
};

const envKeys = [
  "WACHI_ARCHIVE_ACCESS_KEY",
  "WACHI_ARCHIVE_SECRET_KEY",
  "WACHI_NO_ARCHIVE",
] as const;

const envSnapshot = new Map<string, string | undefined>();
for (const key of envKeys) {
  envSnapshot.set(key, process.env[key]);
}

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;

const capturedRequests: CapturedRequest[] = [];

let notificationShouldFail = false;
let tempDir = "";
let connection: ConnectedDb | null = null;

const makeStream = (text: string): ReadableStream<Uint8Array> => {
  return new Response(text).body as ReadableStream<Uint8Array>;
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-handle-items-archive-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
  capturedRequests.length = 0;
  notificationShouldFail = false;
  resetArchivePoolForTest();
  resetSendNotificationStateForTest();

  for (const key of envKeys) {
    delete process.env[key];
  }

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    capturedRequests.push({
      method: request.method,
      url: request.url,
    });
    return new Response("ok");
  }) as typeof fetch;

  Bun.spawn = ((command: string[]) => {
    if (command[0] === "sh" && command[2]?.includes("command -v uvx")) {
      return { exited: Promise.resolve(0), kill: () => {} } as MockProc;
    }

    if (command[0] === "uvx" && command[1] === "apprise") {
      return {
        exited: Promise.resolve(notificationShouldFail ? 1 : 0),
        stdout: makeStream(""),
        stderr: makeStream(notificationShouldFail ? "delivery failed" : ""),
        kill: () => {},
      } as MockProc;
    }

    return { exited: Promise.resolve(0), kill: () => {} } as MockProc;
  }) as unknown as typeof Bun.spawn;
});

afterEach(async () => {
  await flushArchivePool(100);
  resetArchivePoolForTest();
  resetSendNotificationStateForTest();
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  connection?.sqlite.close();
  connection = null;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }

  for (const key of envKeys) {
    const original = envSnapshot.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

const makeStats = (): CheckStats => ({ sent: [], skipped: 0, errors: [], networkSkipped: 0 });

describe("handleSubscriptionItems archive integration", () => {
  it("archives the transformed x.com link after a successful notification", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const originalLink = "https://x.com/user/status/123456";
    const effectiveChannelUrl = "discord://12345/token";
    const destinationId = resolveDestinationId(db, buildDestinationKey(effectiveChannelUrl));
    const stats = makeStats();
    await handleSubscriptionItems({
      items: [{ title: "Tweet Thread", link: originalLink }],
      channelName: "main",
      destinationId,
      subscriptionUrl: "https://x.com",
      db,
      dryRun: false,
      baseline: false,
      isJson: true,
      isVerbose: false,
      stats,
      linkTransforms: [{ from: "x.com", to: "fixupx.com" }],
    });
    await drainDestinationOutbox({
      db,
      destinationId,
      effectiveChannelUrl,
      isJson: true,
      isVerbose: false,
      stats,
    });
    await flushArchivePool(100);

    expect(capturedRequests).toEqual([
      {
        method: "GET",
        url: "https://web.archive.org/save/https://fixupx.com/user/status/123456",
      },
    ]);
  });

  it("keeps archiving the original link for non-twitter hosts", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const originalLink = "https://example.com/post";
    const effectiveChannelUrl = "discord://12345/token";
    const destinationId = resolveDestinationId(db, buildDestinationKey(effectiveChannelUrl));
    const stats = makeStats();
    await handleSubscriptionItems({
      items: [{ title: "Post", link: originalLink }],
      channelName: "main",
      destinationId,
      subscriptionUrl: "https://example.com/feed.xml",
      db,
      dryRun: false,
      baseline: false,
      isJson: true,
      isVerbose: false,
      stats,
      linkTransforms: [{ from: "example.com", to: "mirror.example.com" }],
    });
    await drainDestinationOutbox({
      db,
      destinationId,
      effectiveChannelUrl,
      isJson: true,
      isVerbose: false,
      stats,
    });
    await flushArchivePool(100);

    expect(capturedRequests).toEqual([
      {
        method: "GET",
        url: `https://web.archive.org/save/${originalLink}`,
      },
    ]);
  });

  it("does not archive anything in dry-run mode", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const effectiveChannelUrl = "discord://12345/token";
    const destinationId = resolveDestinationId(db, buildDestinationKey(effectiveChannelUrl));
    const stats = makeStats();
    await handleSubscriptionItems({
      items: [{ title: "Post", link: "https://example.com/post" }],
      channelName: "main",
      destinationId,
      subscriptionUrl: "https://example.com/feed.xml",
      db,
      dryRun: true,
      baseline: false,
      isJson: true,
      isVerbose: false,
      stats,
      linkTransforms: [],
    });
    await drainDestinationOutbox({
      db,
      destinationId,
      effectiveChannelUrl,
      isJson: true,
      isVerbose: false,
      stats,
    });
    await flushArchivePool(100);

    expect(capturedRequests).toHaveLength(0);
  });

  it("does not archive when notification delivery fails", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    notificationShouldFail = true;
    const effectiveChannelUrl = "discord://12345/token";
    const destinationId = resolveDestinationId(db, buildDestinationKey(effectiveChannelUrl));
    const stats = makeStats();

    await handleSubscriptionItems({
      items: [{ title: "Post", link: "https://example.com/post" }],
      channelName: "main",
      destinationId,
      subscriptionUrl: "https://example.com/feed.xml",
      db,
      dryRun: false,
      baseline: false,
      isJson: true,
      isVerbose: false,
      stats,
      linkTransforms: [],
    });
    await drainDestinationOutbox({
      db,
      destinationId,
      effectiveChannelUrl,
      isJson: true,
      isVerbose: false,
      stats,
    });
    await flushArchivePool(100);

    expect(capturedRequests).toHaveLength(0);
    expect(stats.errors).toHaveLength(1);
  });
});
