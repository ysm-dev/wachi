import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainDestinationOutbox } from "../../src/lib/check/drain-outbox.ts";
import { handleSubscriptionFailure } from "../../src/lib/check/handle-failure.ts";
import type { CheckStats } from "../../src/lib/check/handle-items.ts";
import { type ConnectedDb, connectDb } from "../../src/lib/db/connect.ts";
import { resolveDestinationId } from "../../src/lib/db/delivery-ledger.ts";
import { listDeliveryOutbox } from "../../src/lib/db/delivery-outbox.ts";
import { getHealthState } from "../../src/lib/db/get-health-state.ts";
import { beginHealthAttempt } from "../../src/lib/db/health-attempt.ts";
import { markHealthSuccess } from "../../src/lib/db/mark-health-success.ts";
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

const originalSpawn = Bun.spawn;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

let tempDir = "";
let connection: ConnectedDb | null = null;
const sentAppriseUrls: string[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-handle-failure-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
  sentAppriseUrls.length = 0;

  Bun.spawn = ((command: string[]) => {
    if (command[0] === "sh" && command[2]?.includes("command -v uvx")) {
      return { exited: Promise.resolve(0), kill: () => {} } as MockProc;
    }

    if (command[0] === "uvx" && command[1] === "apprise") {
      sentAppriseUrls.push(command[4] ?? "");
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

  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

const makeStats = (): CheckStats => ({
  sent: [],
  skipped: 0,
  errors: [],
  networkSkipped: 0,
});

describe("handleSubscriptionFailure", () => {
  it("durably queues and sends failure alerts", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/site") {
          return new Response(
            "<html><head><title>Example Site</title><link rel='icon' href='/icons/site.png'></head></html>",
            { headers: { "content-type": "text/html" } },
          );
        }

        if (url.pathname === "/icons/site.png") {
          return new Response("icon", {
            headers: { "content-type": "image/png" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const subscription = {
      url: `http://127.0.0.1:${server.port}/site`,
      rss_url: `http://127.0.0.1:${server.port}/feed.xml`,
    };

    const stats = makeStats();
    const destinationId = resolveDestinationId(db, buildDestinationKey("discord://12345/token"));
    for (let i = 0; i < 10; i++) {
      await handleSubscriptionFailure({
        channelName: "main",
        destinationId,
        subscription,
        db,
        dryRun: false,
        stats,
        error: new Error("boom"),
        attemptGeneration: beginHealthAttempt(db, "main", subscription.url),
      });
    }

    expect(listDeliveryOutbox(db, destinationId)).toHaveLength(1);
    await drainDestinationOutbox({
      db,
      destinationId,
      effectiveChannelUrl: "discord://12345/token",
      isJson: true,
      isVerbose: false,
      stats,
    });

    expect(sentAppriseUrls).toHaveLength(1);
    expect(decodeURIComponent(sentAppriseUrls[0] ?? "")).toContain("discord://12345/token");
    expect(listDeliveryOutbox(db, destinationId)).toHaveLength(0);

    markHealthSuccess(
      db,
      "main",
      subscription.url,
      beginHealthAttempt(db, "main", subscription.url),
    );
    for (let i = 0; i < 10; i++) {
      await handleSubscriptionFailure({
        channelName: "main",
        destinationId,
        subscription,
        db,
        dryRun: false,
        stats,
        error: new Error("boom again"),
        attemptGeneration: beginHealthAttempt(db, "main", subscription.url),
      });
    }
    expect(listDeliveryOutbox(db, destinationId)).toHaveLength(1);
  });

  it("rolls back a milestone count when queue admission fails", async () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }
    const subscription = {
      url: "https://example.com/site",
      rss_url: "https://example.com/feed.xml",
    };
    const destinationId = resolveDestinationId(db, buildDestinationKey("discord://12345/token"));
    const stats = makeStats();
    for (let i = 0; i < 9; i++) {
      await handleSubscriptionFailure({
        channelName: "main",
        destinationId,
        subscription,
        db,
        dryRun: false,
        stats,
        error: new Error("boom"),
        attemptGeneration: beginHealthAttempt(db, "main", subscription.url),
      });
    }

    await expect(
      handleSubscriptionFailure({
        channelName: "main",
        destinationId: -1,
        subscription,
        db,
        dryRun: false,
        stats,
        error: new Error("boom"),
        attemptGeneration: beginHealthAttempt(db, "main", subscription.url),
      }),
    ).rejects.toThrow("destinationId");

    expect(getHealthState(db, "main", subscription.url).consecutiveFailures).toBe(9);
    expect(listDeliveryOutbox(db, destinationId)).toHaveLength(0);
  });
});
