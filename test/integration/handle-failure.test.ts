import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSubscriptionFailure } from "../../src/lib/check/handle-failure.ts";
import type { CheckStats } from "../../src/lib/check/handle-items.ts";
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

const immediateEnqueue = async (_channelUrl: string, task: () => Promise<void>): Promise<void> => {
  await task();
};

const makeStats = (): CheckStats => ({
  sent: [],
  skipped: 0,
  errors: [],
  networkSkipped: 0,
});

describe("handleSubscriptionFailure", () => {
  it("sends failure alerts with source identity", async () => {
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
    for (let i = 0; i < 10; i++) {
      await handleSubscriptionFailure({
        channelName: "main",
        effectiveChannelUrl: "discord://12345/token",
        subscription,
        db,
        dryRun: false,
        stats,
        enqueueForChannel: immediateEnqueue,
        error: new Error("boom"),
      });
    }

    expect(sentAppriseUrls).toHaveLength(1);
    const decoded = decodeURIComponent(sentAppriseUrls[0] ?? "");
    expect(decoded).toContain("discord://Example Site@12345/token");
    expect(decoded).toContain(`avatar_url=http://127.0.0.1:${server.port}/icons/site.png`);
  });
});
