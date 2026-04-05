import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckStats } from "../../src/lib/check/handle-items.ts";
import { handleSubscriptionItems } from "../../src/lib/check/handle-items.ts";
import { type ConnectedDb, connectDb } from "../../src/lib/db/connect.ts";
import { resetSendNotificationStateForTest } from "../../src/lib/notify/send.ts";

type MockProc = {
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  kill: () => void;
};

const makeStream = (text: string): ReadableStream<Uint8Array> => {
  return new Response(text).body as ReadableStream<Uint8Array>;
};

let tempDir = "";
let connection: ConnectedDb | null = null;
const originalSpawn = Bun.spawn;
const capturedBodies: string[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-link-transform-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
  capturedBodies.length = 0;

  Bun.spawn = ((command: string[]) => {
    // uvx check (command -v uvx)
    if (command[0] === "sh" && command[2]?.includes("command -v uvx")) {
      return { exited: Promise.resolve(0), kill: () => {} } as MockProc;
    }
    // uvx apprise -b <body> <url>
    if (command[0] === "uvx" && command[1] === "apprise") {
      const bodyIndex = command.indexOf("-b");
      if (bodyIndex !== -1) {
        capturedBodies.push(command[bodyIndex + 1] ?? "");
      }
      return {
        exited: Promise.resolve(0),
        stdout: makeStream(""),
        stderr: makeStream(""),
        kill: () => {},
      } as MockProc;
    }
    return { exited: Promise.resolve(0), kill: () => {} } as MockProc;
  }) as unknown as typeof Bun.spawn;
});

afterEach(async () => {
  Bun.spawn = originalSpawn;
  resetSendNotificationStateForTest();
  connection?.sqlite.close();
  connection = null;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

const immediateEnqueue = async (_channelUrl: string, task: () => Promise<void>): Promise<void> => {
  await task();
};

const makeStats = (): CheckStats => ({ sent: [], skipped: 0, errors: [], networkSkipped: 0 });

describe("handleSubscriptionItems with linkTransforms", () => {
  it("sends notification body with transformed link", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const stats = makeStats();
    await handleSubscriptionItems({
      items: [{ title: "Tweet Thread", link: "https://x.com/user/status/123456" }],
      channelName: "main",
      effectiveChannelUrl: "slack://token/channel",
      subscriptionUrl: "https://x.com",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats,
      enqueueForChannel: immediateEnqueue,
      linkTransforms: [{ from: "x.com", to: "fixupx.com" }],
    });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toContain("https://fixupx.com/user/status/123456");
    expect(capturedBodies[0]).not.toContain("https://x.com/user/status/123456");
    expect(capturedBodies[0]).toContain("Tweet Thread");
    expect(stats.sent).toHaveLength(1);
  });

  it("dedup uses original link (second call is skipped even with transforms)", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const items = [{ title: "Tweet", link: "https://x.com/user/status/999" }];
    const transforms = [{ from: "x.com", to: "fixupx.com" }];

    const stats1 = makeStats();
    await handleSubscriptionItems({
      items,
      channelName: "main",
      effectiveChannelUrl: "slack://token/channel",
      subscriptionUrl: "https://x.com",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats: stats1,
      enqueueForChannel: immediateEnqueue,
      linkTransforms: transforms,
    });
    expect(stats1.sent).toHaveLength(1);
    expect(capturedBodies).toHaveLength(1);

    // Same item again → deduped, no second notification
    const stats2 = makeStats();
    await handleSubscriptionItems({
      items,
      channelName: "main",
      effectiveChannelUrl: "slack://token/channel",
      subscriptionUrl: "https://x.com",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats: stats2,
      enqueueForChannel: immediateEnqueue,
      linkTransforms: transforms,
    });
    expect(stats2.skipped).toBe(1);
    expect(stats2.sent).toHaveLength(0);
    expect(capturedBodies).toHaveLength(1); // no new call
  });

  it("changing transforms does not re-send deduped items", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const items = [{ title: "Tweet", link: "https://x.com/user/status/777" }];

    const stats1 = makeStats();
    await handleSubscriptionItems({
      items,
      channelName: "main",
      effectiveChannelUrl: "slack://token/channel",
      subscriptionUrl: "https://x.com",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats: stats1,
      enqueueForChannel: immediateEnqueue,
      linkTransforms: [{ from: "x.com", to: "fixupx.com" }],
    });
    expect(stats1.sent).toHaveLength(1);

    // Change transform target → still deduped (hash uses original link)
    const stats2 = makeStats();
    await handleSubscriptionItems({
      items,
      channelName: "main",
      effectiveChannelUrl: "slack://token/channel",
      subscriptionUrl: "https://x.com",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats: stats2,
      enqueueForChannel: immediateEnqueue,
      linkTransforms: [{ from: "x.com", to: "vxtwitter.com" }],
    });
    expect(stats2.skipped).toBe(1);
    expect(capturedBodies).toHaveLength(1);
  });

  it("sends original link when linkTransforms is empty", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const stats = makeStats();
    await handleSubscriptionItems({
      items: [{ title: "Post", link: "https://x.com/user/status/555" }],
      channelName: "main",
      effectiveChannelUrl: "slack://token/channel",
      subscriptionUrl: "https://x.com",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats,
      enqueueForChannel: immediateEnqueue,
      linkTransforms: [],
    });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toContain("https://x.com/user/status/555");
  });
});
