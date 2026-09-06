import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckStats } from "../../src/lib/check/handle-items.ts";
import type { PendingFailure } from "../../src/lib/check/process-subscription.ts";
import { resolveSubscriptionFailures } from "../../src/lib/check/resolve-failures.ts";
import { type ConnectedDb, connectDb } from "../../src/lib/db/connect.ts";
import { resolveDestinationId } from "../../src/lib/db/delivery-ledger.ts";
import { listDeliveryOutbox } from "../../src/lib/db/delivery-outbox.ts";
import { getHealthState } from "../../src/lib/db/get-health-state.ts";
import { beginHealthAttempt } from "../../src/lib/db/health-attempt.ts";
import { NetworkLevelError } from "../../src/lib/http/check-connectivity.ts";
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

let tempDir = "";
let connection: ConnectedDb | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
const sentAppriseUrls: string[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-resolve-failures-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
  sentAppriseUrls.length = 0;

  // Branding lookups hit the subscription URL; a local 404 keeps the test hermetic.
  server = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) });

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
  server?.stop();
  server = null;
  connection?.sqlite.close();
  connection = null;

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

const requireDb = () => {
  const db = connection?.db;
  if (!db) {
    throw new Error("db not initialized");
  }
  return db;
};

// Branding resolution fetches `url`, so it points at the local server. `rss_url`
// is never fetched on the failure path, so its host can be varied freely and for
// free -- which is what the host-outage grouping keys on.
const subscriptionUrl = (index: number): string =>
  `http://127.0.0.1:${server?.port ?? 0}/site-${index}`;

const makeFailure = (
  index: number,
  { networkLevel = false, host }: { networkLevel?: boolean; host?: string } = {},
): PendingFailure => {
  const error = networkLevel
    ? new NetworkLevelError("connect", "connect failed")
    : new Error("HTTP 500");
  const effectiveChannelUrl = `discord://1234${index % 3}/token`;
  return {
    channelName: `channel-${index % 3}`,
    effectiveChannelUrl,
    destinationId: resolveDestinationId(requireDb(), buildDestinationKey(effectiveChannelUrl)),
    subscription: {
      url: subscriptionUrl(index),
      // Default to a unique host per subscription so tests opt in to sharing one.
      rss_url: `http://${host ?? `feed-${index}.example`}/rss-${index}.xml`,
    },
    error,
    networkLevel,
    attemptGeneration: 0,
  };
};

/**
 * By default every attempted subscription is assumed to sit on its own host, so
 * host-outage detection stays out of the way unless a test sets it up.
 */
const runResolve = async (
  failures: PendingFailure[],
  totalSubscriptions: number,
  stats: CheckStats,
  attemptsByHost?: ReadonlyMap<string, number>,
) =>
  resolveSubscriptionFailures({
    failures: failures.map((failure) => ({
      ...failure,
      attemptGeneration: beginHealthAttempt(
        requireDb(),
        failure.channelName,
        failure.subscription.url,
      ),
    })),
    totalSubscriptions,
    attemptsByHost: attemptsByHost ?? new Map<string, number>(),
    db: requireDb(),
    dryRun: false,
    stats,
  });

describe("resolveSubscriptionFailures / run-level outage detection", () => {
  it("leaves health unchanged when transport failures span the run", async () => {
    const db = requireDb();
    const stats = makeStats();
    const failures = Array.from({ length: 6 }, (_, index) =>
      makeFailure(index, { networkLevel: true }),
    );

    for (let run = 0; run < 15; run++) {
      const result = await runResolve(failures, 6, stats);
      expect(result.outageSuspected).toBe(true);
      expect(result.suppressed).toBe(6);
      expect(result.total).toBe(6);
    }

    for (const failure of failures) {
      const health = getHealthState(db, failure.channelName, failure.subscription.url);
      expect(health.consecutiveFailures).toBe(0);
    }
    expect(listDeliveryOutbox(db)).toHaveLength(0);

    // Errors are still reported so the exit code and --json output stay truthful.
    expect(stats.errors).toHaveLength(6 * 15);
    expect(stats.networkSkipped).toBe(6 * 15);
  });

  it("does not suppress HTTP failures even when the whole run fails", async () => {
    const db = requireDb();
    const stats = makeStats();
    const failures = Array.from({ length: 6 }, (_, index) => makeFailure(index));

    for (let run = 0; run < 10; run++) {
      const result = await runResolve(failures, 6, stats);
      expect(result.outageSuspected).toBe(false);
      expect(result.suppressed).toBe(0);
    }

    for (const failure of failures) {
      expect(
        getHealthState(db, failure.channelName, failure.subscription.url).consecutiveFailures,
      ).toBe(10);
    }
    expect(listDeliveryOutbox(db)).toHaveLength(6);
  });

  it("suppresses transport failures but preserves server failures in a mixed run", async () => {
    const db = requireDb();
    const stats = makeStats();
    const failures = [
      makeFailure(0, { networkLevel: true }),
      makeFailure(1, { networkLevel: true }),
      makeFailure(2, { networkLevel: true }),
      makeFailure(3),
      makeFailure(4),
      makeFailure(5),
    ];

    const result = await runResolve(failures, 6, stats);

    expect(result.outageSuspected).toBe(true);
    expect(result.suppressed).toBe(3);
    expect(sentAppriseUrls).toHaveLength(0);

    for (const failure of failures.slice(0, 3)) {
      expect(
        getHealthState(db, failure.channelName, failure.subscription.url).consecutiveFailures,
      ).toBe(0);
    }
    for (const failure of failures.slice(3)) {
      expect(
        getHealthState(db, failure.channelName, failure.subscription.url).consecutiveFailures,
      ).toBe(1);
    }
    expect(stats.networkSkipped).toBe(3);
    expect(stats.errors).toHaveLength(6);
  });

  it("handles failures normally when only a minority fail", async () => {
    const db = requireDb();
    const stats = makeStats();
    const failures = [makeFailure(0), makeFailure(1)];

    for (let run = 0; run < 10; run++) {
      const result = await runResolve(failures, 6, stats);
      expect(result.outageSuspected).toBe(false);
      expect(result.suppressed).toBe(0);
    }

    for (const failure of failures) {
      expect(
        getHealthState(db, failure.channelName, failure.subscription.url).consecutiveFailures,
      ).toBe(10);
    }

    // One durable alert per subscription at the 10-failure milestone.
    expect(listDeliveryOutbox(db)).toHaveLength(2);
  });

  it("does not suppress runs below the minimum sample size", async () => {
    const db = requireDb();
    const stats = makeStats();
    const failures = Array.from({ length: 4 }, (_, index) => makeFailure(index));

    const result = await runResolve(failures, 4, stats);

    expect(result.outageSuspected).toBe(false);
    for (const failure of failures) {
      expect(
        getHealthState(db, failure.channelName, failure.subscription.url).consecutiveFailures,
      ).toBe(1);
    }
  });

  it("records isolated network failures for eventual alerting", async () => {
    const db = requireDb();
    const stats = makeStats();
    const failures = [
      makeFailure(0, { networkLevel: true }),
      makeFailure(1, { networkLevel: true }),
    ];

    const result = await runResolve(failures, 10, stats);

    expect(result.outageSuspected).toBe(false);
    expect(stats.networkSkipped).toBe(0);
    expect(stats.errors).toHaveLength(2);
    expect(sentAppriseUrls).toHaveLength(0);
    for (const failure of failures) {
      expect(
        getHealthState(db, failure.channelName, failure.subscription.url).consecutiveFailures,
      ).toBe(1);
    }
  });

  it("is a no-op when nothing failed", async () => {
    const stats = makeStats();
    const result = await runResolve([], 20, stats);

    expect(result).toEqual({ outageSuspected: false, outagedHosts: [], suppressed: 0, total: 20 });
    expect(stats.errors).toHaveLength(0);
  });
});

/**
 * Models the real topology that produced the flood: one self-hosted feed service
 * backing many distinct subscriptions spread across many channels. The service
 * dies, every subscription behind it fails, and none of the run-level thresholds
 * are anywhere close to being met.
 */
describe("resolveSubscriptionFailures / host outage detection", () => {
  const TORSS = "localhost:8677";
  const RSSHUB = "localhost:1200";

  it("records a dead shared backend while retaining outage correlation", async () => {
    const db = requireDb();
    const stats = makeStats();

    // 17 torss subscriptions out of 124 total -- 14%, far below the run-level 50%.
    const failures = Array.from({ length: 17 }, (_, index) =>
      makeFailure(index, { host: TORSS, networkLevel: true }),
    );
    const attempts = new Map([
      [TORSS, 17],
      [RSSHUB, 19],
      ["github.com", 15],
    ]);

    for (let run = 0; run < 15; run++) {
      const result = await runResolve(failures, 124, stats, attempts);
      expect(result.outageSuspected).toBe(false);
      expect(result.outagedHosts).toEqual([TORSS]);
      expect(result.suppressed).toBe(0);
    }

    for (const failure of failures) {
      expect(
        getHealthState(db, failure.channelName, failure.subscription.url).consecutiveFailures,
      ).toBe(15);
    }
    expect(listDeliveryOutbox(db)).toHaveLength(17);
    expect(stats.errors).toHaveLength(17 * 15);
  });

  it("correlates each dead host without suppressing failures", async () => {
    const stats = makeStats();
    const failures = [
      ...Array.from({ length: 4 }, (_, i) => makeFailure(i, { host: TORSS })),
      ...Array.from({ length: 3 }, (_, i) => makeFailure(10 + i, { host: RSSHUB })),
    ];
    const attempts = new Map([
      [TORSS, 4],
      [RSSHUB, 3],
      ["github.com", 15],
    ]);

    const result = await runResolve(failures, 124, stats, attempts);

    expect(result.outagedHosts).toEqual([RSSHUB, TORSS]);
    expect(result.suppressed).toBe(0);
    expect(sentAppriseUrls).toHaveLength(0);
  });

  it("still alerts on one broken route when the rest of the host is healthy", async () => {
    const db = requireDb();
    const stats = makeStats();
    // Only 1 of the 17 torss subscriptions fails: the host is fine, the feed is not.
    const failures = [makeFailure(0, { host: TORSS })];
    const attempts = new Map([[TORSS, 17]]);

    for (let run = 0; run < 10; run++) {
      const result = await runResolve(failures, 124, stats, attempts);
      expect(result.outagedHosts).toEqual([]);
      expect(result.suppressed).toBe(0);
    }

    const failure = failures[0];
    if (!failure) {
      throw new Error("missing failure");
    }
    expect(
      getHealthState(db, failure.channelName, failure.subscription.url).consecutiveFailures,
    ).toBe(10);
    expect(listDeliveryOutbox(db)).toHaveLength(1);
  });

  it("does not suppress a host with too few subscriptions to be conclusive", async () => {
    const db = requireDb();
    const stats = makeStats();
    // 2 subscriptions on a host, both failing: indistinguishable from 2 dead feeds.
    const failures = [
      makeFailure(0, { host: "tiny.example" }),
      makeFailure(1, { host: "tiny.example" }),
    ];
    const attempts = new Map([["tiny.example", 2]]);

    const result = await runResolve(failures, 124, stats, attempts);

    expect(result.outagedHosts).toEqual([]);
    for (const failure of failures) {
      expect(
        getHealthState(db, failure.channelName, failure.subscription.url).consecutiveFailures,
      ).toBe(1);
    }
  });

  it("keeps services on the same hostname but different ports separate", async () => {
    const db = requireDb();
    const stats = makeStats();
    // torss is down; RSSHub on the same localhost is healthy apart from one feed.
    const failures = [
      ...Array.from({ length: 3 }, (_, i) => makeFailure(i, { host: TORSS })),
      makeFailure(20, { host: RSSHUB }),
    ];
    const attempts = new Map([
      [TORSS, 3],
      [RSSHUB, 19],
    ]);

    const result = await runResolve(failures, 124, stats, attempts);

    expect(result.outagedHosts).toEqual([TORSS]);
    expect(result.suppressed).toBe(0);

    const rsshubFailure = failures[3];
    if (!rsshubFailure) {
      throw new Error("missing failure");
    }
    expect(
      getHealthState(db, rsshubFailure.channelName, rsshubFailure.subscription.url)
        .consecutiveFailures,
    ).toBe(1);
  });
});
