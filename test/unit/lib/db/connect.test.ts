import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sentItems } from "../../../../src/lib/db/schema.ts";
import { WachiError } from "../../../../src/utils/error.ts";

const pathsModulePath = new URL("../../../../src/utils/paths.ts", import.meta.url).pathname;
const envModulePath = new URL("../../../../src/utils/env.ts", import.meta.url).pathname;

let canonicalDbPath = "";
let legacyDbPath = "";
let envDbPath: string | undefined;

mock.module(pathsModulePath, () => ({
  ensureParentDir: async (filePath: string) => {
    await mkdir(dirname(filePath), { recursive: true });
  },
  getDefaultDbPath: () => canonicalDbPath,
  getLegacyNodejsDbPath: () => legacyDbPath,
}));

mock.module(envModulePath, () => ({
  getEnv: () => ({ dbPath: envDbPath }),
}));

const { connectDb } = await import("../../../../src/lib/db/connect.ts");
type ConnectedDb = Awaited<ReturnType<typeof connectDb>>;

let tempDir = "";
let connection: ConnectedDb | null = null;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-db-connect-"));
  canonicalDbPath = join(tempDir, "canonical", "wachi.db");
  legacyDbPath = join(tempDir, "legacy", "wachi.db");
  envDbPath = undefined;
  connection = null;
});

afterEach(async () => {
  connection?.sqlite.close();
  connection = null;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("connectDb", () => {
  it("recovers from a corrupted database file by resetting it", async () => {
    const dbPath = join(tempDir, "wachi.db");
    await writeFile(dbPath, "not a sqlite database", "utf8");

    connection = await connectDb(dbPath);

    expect(connection.path).toBe(dbPath);
    const rows = connection.db.select().from(sentItems).all();
    expect(rows).toHaveLength(0);
  });

  it("wraps open failures in WachiError", async () => {
    const dbAsDirectory = join(tempDir, "wachi.db");
    await mkdir(dbAsDirectory, { recursive: true });

    await expect(connectDb(dbAsDirectory)).rejects.toBeInstanceOf(WachiError);
  });

  it("uses env db path when no override is provided", async () => {
    envDbPath = join(tempDir, "env-db", "wachi.db");

    connection = await connectDb();

    expect(connection.path).toBe(envDbPath);
    expect(await pathExists(envDbPath)).toBe(true);
  });

  it("uses canonical default path when no legacy database exists", async () => {
    expect(await pathExists(canonicalDbPath)).toBe(false);
    expect(await pathExists(legacyDbPath)).toBe(false);

    connection = await connectDb();

    expect(connection.path).toBe(canonicalDbPath);
    expect(await pathExists(canonicalDbPath)).toBe(true);
  });

  it("migrates a legacy runtime database to canonical default path", async () => {
    const legacyConnection = await connectDb(legacyDbPath);
    legacyConnection.db
      .insert(sentItems)
      .values({
        dedupHash: `legacy-hash-${Date.now()}-${Math.random()}`,
        channelUrl: "main",
        subscriptionUrl: "https://example.com/feed",
        title: "Legacy",
        link: "https://example.com/legacy",
        sentAt: new Date().toISOString(),
      })
      .run();
    legacyConnection.sqlite.close();

    expect(await pathExists(canonicalDbPath)).toBe(false);

    let stderr = "";
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      connection = await connectDb();
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    expect(connection.path).toBe(canonicalDbPath);
    const rows = connection.db.select().from(sentItems).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Legacy");
    expect(stderr).toContain("Migrated database from legacy runtime path");
    expect(await pathExists(legacyDbPath)).toBe(false);
  });

  it("keeps canonical database when it already exists", async () => {
    const seededCanonical = await connectDb(canonicalDbPath);
    seededCanonical.db
      .insert(sentItems)
      .values({
        dedupHash: `canonical-hash-${Date.now()}-${Math.random()}`,
        channelUrl: "alerts",
        subscriptionUrl: "https://example.com/rss",
        title: "Canonical",
        link: "https://example.com/item",
        sentAt: new Date().toISOString(),
      })
      .run();
    seededCanonical.sqlite.close();

    const seededLegacy = await connectDb(legacyDbPath);
    seededLegacy.db
      .insert(sentItems)
      .values({
        dedupHash: `legacy-hash-${Date.now()}-${Math.random()}`,
        channelUrl: "legacy",
        subscriptionUrl: "https://example.com/legacy",
        title: "Legacy",
        link: "https://example.com/legacy-item",
        sentAt: new Date().toISOString(),
      })
      .run();
    seededLegacy.sqlite.close();

    connection = await connectDb();

    expect(connection.path).toBe(canonicalDbPath);
    const rows = connection.db.select().from(sentItems).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Canonical");
    expect(await pathExists(legacyDbPath)).toBe(true);
  });
});
