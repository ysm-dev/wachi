import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import { getHealthState } from "../../../../src/lib/db/get-health-state.ts";
import { listHealthStates } from "../../../../src/lib/db/list-health-states.ts";
import { markHealthFailure } from "../../../../src/lib/db/mark-health-failure.ts";
import { markHealthSuccess } from "../../../../src/lib/db/mark-health-success.ts";

let tempDir = "";
let connection: ConnectedDb | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-db-health-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
});

afterEach(async () => {
  connection?.sqlite.close();
  connection = null;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("health db operations", () => {
  it("getHealthState returns defaults when no row exists", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const state = getHealthState(db, "slack://token", "https://example.com");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it("markHealthFailure increments consecutive failures", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const first = markHealthFailure(db, "slack://token", "https://example.com", "boom");
    const second = markHealthFailure(db, "slack://token", "https://example.com", "boom");

    expect(first.consecutiveFailures).toBe(1);
    expect(second.consecutiveFailures).toBe(2);
  });

  it("markHealthSuccess resets failure state", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    markHealthFailure(db, "slack://token", "https://example.com", "boom");
    markHealthSuccess(db, "slack://token", "https://example.com");
    const state = getHealthState(db, "slack://token", "https://example.com");

    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it("listHealthStates returns persisted records", () => {
    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    markHealthFailure(db, "slack://one", "https://example.com/1", "error 1");
    markHealthFailure(db, "slack://two", "https://example.com/2", "error 2");

    const all = listHealthStates(db);
    expect(all).toHaveLength(2);
  });

  it("getHealthState falls back to defaults for malformed rows", () => {
    const sqlite = connection?.sqlite;
    const db = connection?.db;
    if (!sqlite || !db) {
      throw new Error("db not initialized");
    }

    sqlite.exec(`
      INSERT INTO health (channel_url, subscription_url, consecutive_failures, last_error, last_failure_at)
      VALUES ('slack://bad', 'https://example.com/bad', 'not-a-number', NULL, NULL);
    `);

    const state = getHealthState(db, "slack://bad", "https://example.com/bad");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it("listHealthStates keeps valid rows when mixed with malformed rows", () => {
    const sqlite = connection?.sqlite;
    const db = connection?.db;
    if (!sqlite || !db) {
      throw new Error("db not initialized");
    }

    markHealthFailure(db, "slack://good", "https://example.com/good", "boom");
    sqlite.exec(`
      INSERT INTO health (channel_url, subscription_url, consecutive_failures, last_error, last_failure_at)
      VALUES ('slack://bad', 'https://example.com/bad', 'not-a-number', NULL, NULL);
    `);

    const all = listHealthStates(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.channelUrl).toBe("slack://good");
  });
});
