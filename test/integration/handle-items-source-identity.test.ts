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
const capturedAppriseUrls: string[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-handle-items-identity-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
  capturedAppriseUrls.length = 0;

  Bun.spawn = ((command: string[]) => {
    if (command[0] === "sh" && command[2]?.includes("command -v uvx")) {
      return { exited: Promise.resolve(0), kill: () => {} } as MockProc;
    }
    if (command[0] === "uvx" && command[1] === "apprise") {
      // uvx apprise -b <body> <url>
      capturedAppriseUrls.push(command[4] ?? "");
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

const decodeAvatarUrl = (appriseUrl: string): string | undefined => {
  try {
    const parsed = new URL(appriseUrl);
    return parsed.searchParams.get("avatar_url") ?? undefined;
  } catch {
    return undefined;
  }
};

describe("handleSubscriptionItems source identity fallback", () => {
  it("uses feed-level avatar for all items when sourceIdentity has avatarUrl", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const stats = makeStats();
    await handleSubscriptionItems({
      items: [
        { title: "Post A", link: "https://first.example/a" },
        { title: "Post B", link: "https://second.example/b" },
      ],
      channelName: "main",
      effectiveChannelUrl: "discord://12345/token",
      subscriptionUrl: "https://feed.example/rss",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats,
      enqueueForChannel: immediateEnqueue,
      sourceIdentity: {
        username: "Example Feed",
        avatarUrl: "https://feed.example/icon.png",
      },
      linkTransforms: [],
    });

    expect(capturedAppriseUrls).toHaveLength(2);
    expect(decodeAvatarUrl(capturedAppriseUrls[0] ?? "")).toBe("https://feed.example/icon.png");
    expect(decodeAvatarUrl(capturedAppriseUrls[1] ?? "")).toBe("https://feed.example/icon.png");
    expect(stats.sent).toHaveLength(2);
  });

  it("falls back to each item link's favicon when sourceIdentity has no avatarUrl", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const stats = makeStats();
    await handleSubscriptionItems({
      items: [
        { title: "Post A", link: "https://first.example/a" },
        { title: "Post B", link: "https://second.example/b" },
      ],
      channelName: "main",
      effectiveChannelUrl: "discord://12345/token",
      subscriptionUrl: "https://aggregator.example/rss",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats,
      enqueueForChannel: immediateEnqueue,
      sourceIdentity: {
        username: "Aggregator Feed",
      },
      linkTransforms: [],
    });

    expect(capturedAppriseUrls).toHaveLength(2);
    expect(decodeAvatarUrl(capturedAppriseUrls[0] ?? "")).toBe(
      "https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http%3A%2F%2Ffirst.example&size=128",
    );
    expect(decodeAvatarUrl(capturedAppriseUrls[1] ?? "")).toBe(
      "https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http%3A%2F%2Fsecond.example&size=128",
    );
  });

  it("falls back to item link favicon when sourceIdentity is undefined", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const stats = makeStats();
    await handleSubscriptionItems({
      items: [{ title: "Post", link: "https://blog.example/post-1" }],
      channelName: "main",
      effectiveChannelUrl: "discord://12345/token",
      subscriptionUrl: "https://blog.example/rss",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats,
      enqueueForChannel: immediateEnqueue,
      linkTransforms: [],
    });

    expect(capturedAppriseUrls).toHaveLength(1);
    expect(decodeAvatarUrl(capturedAppriseUrls[0] ?? "")).toBe(
      "https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http%3A%2F%2Fblog.example&size=128",
    );
  });

  it("uses original item link (not transformed) for favicon fallback", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const stats = makeStats();
    await handleSubscriptionItems({
      items: [{ title: "Tweet", link: "https://x.com/user/status/123" }],
      channelName: "main",
      effectiveChannelUrl: "discord://12345/token",
      subscriptionUrl: "https://x.com",
      db,
      dryRun: false,
      isJson: true,
      isVerbose: false,
      stats,
      enqueueForChannel: immediateEnqueue,
      sourceIdentity: { username: "X Feed" },
      linkTransforms: [{ from: "x.com", to: "fixupx.com" }],
    });

    expect(capturedAppriseUrls).toHaveLength(1);
    // The body should contain the transformed link, but the avatar uses the original host.
    expect(decodeAvatarUrl(capturedAppriseUrls[0] ?? "")).toBe(
      "https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http%3A%2F%2Fx.com&size=128",
    );
    expect(decodeAvatarUrl(capturedAppriseUrls[0] ?? "")).not.toContain("fixupx.com");
  });
});
