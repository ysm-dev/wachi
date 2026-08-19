import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const makeStream = (text: string): ReadableStream<Uint8Array> => {
  return new Response(text).body as ReadableStream<Uint8Array>;
};

let tempDir = "";
let connection: ConnectedDb | null = null;
const originalSpawn = Bun.spawn;
const capturedBodies: string[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-anchor-links-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
  capturedBodies.length = 0;

  Bun.spawn = ((command: string[]) => {
    if (command[0] === "sh" && command[2]?.includes("command -v uvx")) {
      return { exited: Promise.resolve(0), kill: () => {} } as MockProc;
    }
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

const makeStats = (): CheckStats => ({ sent: [], skipped: 0, errors: [], networkSkipped: 0 });

describe("handleSubscriptionItems with anchor-addressed items", () => {
  it("delivers every comment that differs only by URL fragment", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    // Shape of https://news.hada.io/comments: many comments share one topic page and
    // are addressed only by their "#cid" anchor.
    const items = [
      { title: "first comment", link: "https://news.hada.io/topic?id=32611#cid63660" },
      { title: "second comment", link: "https://news.hada.io/topic?id=32611#cid63659" },
      { title: "third comment", link: "https://news.hada.io/topic?id=32611#cid63658" },
      { title: "other topic", link: "https://news.hada.io/topic?id=32613#cid63687" },
    ];

    const effectiveChannelUrl = "discord://1234/token";
    const destinationId = resolveDestinationId(db, buildDestinationKey(effectiveChannelUrl));
    const stats = makeStats();

    const accepted = await handleSubscriptionItems({
      items,
      channelName: "ko-geeknews_comments",
      destinationId,
      subscriptionUrl: "https://news.hada.io/comments",
      db,
      dryRun: false,
      baseline: false,
      isJson: true,
      isVerbose: false,
      stats,
      linkTransforms: [],
    });

    expect(accepted).toBe(4);
    expect(stats.skipped).toBe(0);

    await drainDestinationOutbox({
      db,
      destinationId,
      effectiveChannelUrl,
      isJson: true,
      isVerbose: false,
      stats,
    });

    expect(stats.sent).toHaveLength(4);
    expect(capturedBodies).toHaveLength(4);
    // The anchor survives into the notification, deep-linking to the exact comment.
    expect(capturedBodies.join("\n")).toContain("https://news.hada.io/topic?id=32611#cid63660");
    expect(capturedBodies.join("\n")).toContain("https://news.hada.io/topic?id=32611#cid63659");
  });

  it("still dedupes an identical anchored link on the next check", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const items = [{ title: "a comment", link: "https://news.hada.io/topic?id=32611#cid63660" }];
    const destinationId = resolveDestinationId(db, buildDestinationKey("discord://1234/token"));

    const first = makeStats();
    expect(
      await handleSubscriptionItems({
        items,
        channelName: "ko-geeknews_comments",
        destinationId,
        subscriptionUrl: "https://news.hada.io/comments",
        db,
        dryRun: false,
        baseline: false,
        isJson: true,
        isVerbose: false,
        stats: first,
        linkTransforms: [],
      }),
    ).toBe(1);

    const second = makeStats();
    expect(
      await handleSubscriptionItems({
        items,
        channelName: "ko-geeknews_comments",
        destinationId,
        subscriptionUrl: "https://news.hada.io/comments",
        db,
        dryRun: false,
        baseline: false,
        isJson: true,
        isVerbose: false,
        stats: second,
        linkTransforms: [],
      }),
    ).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("treats a bare trailing '#' as the same item as the plain link", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");

    const destinationId = resolveDestinationId(db, buildDestinationKey("discord://1234/token"));
    const stats = makeStats();

    const accepted = await handleSubscriptionItems({
      items: [
        { title: "post", link: "https://example.com/post" },
        { title: "post again", link: "https://example.com/post#" },
      ],
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

    expect(accepted).toBe(1);
    expect(stats.skipped).toBe(1);
  });
});
