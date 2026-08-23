import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generatedMigrations } from "../../../../src/lib/db/generated-migrations.ts";
import { sentItems } from "../../../../src/lib/db/schema.ts";
import { WachiError } from "../../../../src/utils/error.ts";

const pathsModulePath = new URL("../../../../src/utils/paths.ts", import.meta.url).pathname;
const envModulePath = new URL("../../../../src/utils/env.ts", import.meta.url).pathname;

let canonicalDbPath = "";
let legacyDbPath = "";
let legacyMacOsDbPath = "";
let envDbPath: string | undefined;

mock.module(pathsModulePath, () => ({
  ensureParentDir: async (filePath: string) => {
    await mkdir(dirname(filePath), { recursive: true });
  },
  getDefaultDbPath: () => canonicalDbPath,
  getLegacyNodejsDbPath: () => legacyDbPath,
  getLegacyMacOsDbPath: () => legacyMacOsDbPath,
}));

// Return a COMPLETE env object (reading process.env, overriding only dbPath).
// Bun applies `mock.module` process-globally and does not reliably restore it
// between test files, so an incomplete stub would leak a broken getEnv into
// other suites (archive/update tests). A full pass-through keeps any leak inert.
const readMockEnv = (name: string): string | undefined => {
  const value = process.env[name];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

mock.module(envModulePath, () => ({
  getEnv: () => ({
    appriseUrlOverride: readMockEnv("WACHI_APPRISE_URL"),
    archiveAccessKey: readMockEnv("WACHI_ARCHIVE_ACCESS_KEY"),
    archiveSecretKey: readMockEnv("WACHI_ARCHIVE_SECRET_KEY"),
    configPath: readMockEnv("WACHI_CONFIG_PATH"),
    dbPath: envDbPath,
    noArchive: readMockEnv("WACHI_NO_ARCHIVE") === "1",
    pathsRoot: readMockEnv("WACHI_PATHS_ROOT"),
    wrapperPath: readMockEnv("WACHI_WRAPPER_PATH"),
    noAutoUpdate: readMockEnv("WACHI_NO_AUTO_UPDATE") === "1",
  }),
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
  legacyMacOsDbPath = join(tempDir, "macos-native", "wachi.db");
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
  it("fails closed without deleting a corrupted database", async () => {
    const dbPath = join(tempDir, "wachi.db");
    const contents = "not a sqlite database";
    await writeFile(dbPath, contents, "utf8");

    await expect(connectDb(dbPath)).rejects.toBeInstanceOf(WachiError);

    expect(await readFile(dbPath, "utf8")).toBe(contents);
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

  it("sets durability and integrity pragmas", async () => {
    connection = await connectDb(join(tempDir, "wachi.db"));

    expect(connection.sqlite.query("PRAGMA busy_timeout").values()[0]?.[0]).toBe(5000);
    expect(connection.sqlite.query("PRAGMA journal_mode").values()[0]?.[0]).toBe("wal");
    expect(connection.sqlite.query("PRAGMA foreign_keys").values()[0]?.[0]).toBe(1);
    expect(connection.sqlite.query("PRAGMA synchronous").values()[0]?.[0]).toBe(2);
  });

  it("creates strict ledger tables without rowids where keys permit it", async () => {
    connection = await connectDb(join(tempDir, "wachi.db"));

    const rows = connection.sqlite
      .query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN ('destinations', 'delivery_keys', 'delivery_outbox', 'schema_migrations')",
      )
      .all();
    const definitions = new Map(rows.map((row) => [row.name, row.sql.toUpperCase()]));

    expect(definitions.get("destinations")).toContain("STRICT");
    expect(definitions.get("delivery_keys")).toContain("STRICT, WITHOUT ROWID");
    expect(definitions.get("delivery_outbox")).toContain("STRICT, WITHOUT ROWID");
    expect(definitions.get("schema_migrations")).toContain("STRICT, WITHOUT ROWID");
  });

  it("tracks migrations and does not reapply them", async () => {
    const dbPath = join(tempDir, "wachi.db");
    connection = await connectDb(dbPath);
    const first = connection.sqlite
      .query<{ id: string; applied_at: string }, []>(
        "SELECT id, applied_at FROM schema_migrations ORDER BY id",
      )
      .all();
    connection.sqlite.close();
    connection = await connectDb(dbPath);
    const second = connection.sqlite
      .query<{ id: string; applied_at: string }, []>(
        "SELECT id, applied_at FROM schema_migrations ORDER BY id",
      )
      .all();

    expect(first.map((row) => row.id)).toEqual([
      "0000_init",
      "0001_add-indexes",
      "0002_public_yellow_claw",
      "0003_mute_alex_power",
      "0004_natural_ronan",
      "0005_tan_leo",
      "0006_mysterious_richard_fisk",
    ]);
    expect(second).toEqual(first);
  });

  it("migrates persisted uncertain deliveries back to pending", async () => {
    const dbPath = join(tempDir, "wachi.db");
    const sqlite = new Database(dbPath, { create: true });
    for (const migration of generatedMigrations.slice(0, 4)) {
      sqlite.exec(migration.sql);
    }
    for (const migration of generatedMigrations.slice(0, 4)) {
      sqlite
        .query("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, new Date().toISOString());
    }
    sqlite.query("INSERT INTO destinations (identity_key) VALUES (?)").run(Buffer.alloc(32, 1));
    sqlite
      .query(
        "INSERT INTO delivery_outbox (destination_id, link_key, payload, source, link, state, attempts, enqueued_seq, available_at, lease_expires_at, last_error) VALUES (1, ?, 'payload', 'source', 'link', 'uncertain', 3, 1, 0, NULL, 'ambiguous')",
      )
      .run(Buffer.alloc(32, 2));
    sqlite.close();

    connection = await connectDb(dbPath);

    const row = connection.sqlite
      .query<{ state: string; claim_generation: number; claim_owner: string | null }, []>(
        "SELECT state, claim_generation, claim_owner FROM delivery_outbox",
      )
      .get();
    expect(row).toEqual({ state: "pending", claim_generation: 0, claim_owner: null });
  });

  it("adopts an existing untracked database idempotently", async () => {
    const dbPath = join(tempDir, "wachi.db");
    connection = await connectDb(dbPath);
    connection.sqlite.exec("DROP TABLE schema_migrations");
    connection.sqlite.close();

    connection = await connectDb(dbPath);

    const tracked = connection.sqlite
      .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
      .all();
    expect(tracked.map((row) => row.id)).toEqual([
      "0000_init",
      "0001_add-indexes",
      "0002_public_yellow_claw",
      "0003_mute_alex_power",
      "0004_natural_ronan",
      "0005_tan_leo",
      "0006_mysterious_richard_fisk",
    ]);
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
    expect(stderr).toContain("Migrated database (legacy runtime)");
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
