import { Database } from "bun:sqlite";
import { access, rm } from "node:fs/promises";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getEnv } from "../../utils/env.ts";
import { WachiError } from "../../utils/error.ts";
import {
  ensureParentDir,
  getDefaultDbPath,
  getLegacyMacOsDbPath,
  getLegacyNodejsDbPath,
} from "../../utils/paths.ts";
import { generatedMigrations } from "./generated-migrations.ts";
import { dbSchema } from "./schema.ts";

const createDrizzleDb = (sqlite: Database) => {
  return drizzle({ client: sqlite, schema: dbSchema });
};

export type WachiDb = ReturnType<typeof createDrizzleDb>;
export type WachiDbSession = Pick<WachiDb, "delete" | "insert" | "select" | "update">;

const createConnectedDb = (sqlite: Database, db: WachiDb, path: string) => {
  return { sqlite, db, path };
};

export type ConnectedDb = ReturnType<typeof createConnectedDb>;

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
`;

const applyGeneratedMigrations = (sqlite: Database): void => {
  sqlite.exec(MIGRATIONS_TABLE_SQL);

  const hasMigration = sqlite.query<{ applied: number }, [string]>(
    "SELECT 1 AS applied FROM schema_migrations WHERE id = ?",
  );
  const recordMigration = sqlite.query(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );

  // An existing database may predate migration tracking. Avoid reapplying the
  // additive health migration when its column is already present.
  const healthColumns = sqlite
    .query<{ name: string }, []>("PRAGMA table_info(health)")
    .all()
    .map((column) => column.name);
  if (healthColumns.includes("last_attempt_at") && !hasMigration.get("0005_tan_leo")) {
    recordMigration.run("0005_tan_leo", new Date().toISOString());
  }
  if (
    healthColumns.includes("attempt_generation") &&
    !hasMigration.get("0006_mysterious_richard_fisk")
  ) {
    recordMigration.run("0006_mysterious_richard_fisk", new Date().toISOString());
  }

  const migrate = sqlite.transaction(() => {
    for (const migration of generatedMigrations) {
      if (hasMigration.get(migration.id)) {
        continue;
      }

      sqlite.exec(migration.sql);
      recordMigration.run(migration.id, new Date().toISOString());
    }
  });

  migrate.immediate();
};

const removeDbFiles = async (dbPath: string): Promise<void> => {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const escapeSqliteString = (value: string): string => {
  return value.replaceAll("'", "''");
};

const exportLegacyDb = (legacyDbPath: string, canonicalDbPath: string): void => {
  const sqlite = new Database(legacyDbPath);
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000;");
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    sqlite.exec(`VACUUM INTO '${escapeSqliteString(canonicalDbPath)}';`);
  } finally {
    sqlite.close();
  }
};

const tryMigrateLegacyDb = async (
  canonicalDbPath: string,
  legacyDbPath: string,
  label: string,
): Promise<boolean> => {
  if (!(await pathExists(legacyDbPath))) {
    return false;
  }

  await ensureParentDir(canonicalDbPath);
  exportLegacyDb(legacyDbPath, canonicalDbPath);
  await removeDbFiles(legacyDbPath);
  process.stderr.write(`Migrated database (${label}): ${legacyDbPath} -> ${canonicalDbPath}\n`);
  return true;
};

const migrateLegacyDbIfNeeded = async (canonicalDbPath: string): Promise<string> => {
  if (await pathExists(canonicalDbPath)) {
    return canonicalDbPath;
  }

  const env = getEnv();
  if (process.platform === "darwin" && !env.pathsRoot && !env.dbPath) {
    if (await tryMigrateLegacyDb(canonicalDbPath, getLegacyMacOsDbPath(), "macOS native")) {
      return canonicalDbPath;
    }
  }

  await tryMigrateLegacyDb(canonicalDbPath, getLegacyNodejsDbPath(), "legacy runtime");
  return canonicalDbPath;
};

const resolveDbPath = async (dbPathOverride?: string): Promise<string> => {
  if (dbPathOverride) {
    return dbPathOverride;
  }

  const env = getEnv();
  if (env.dbPath) {
    return env.dbPath;
  }

  const canonicalDbPath = getDefaultDbPath();
  return await migrateLegacyDbIfNeeded(canonicalDbPath);
};

const initializeSqlite = async (path: string): Promise<ConnectedDb> => {
  const sqlite = new Database(path, { create: true });
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000;");
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    sqlite.exec("PRAGMA synchronous = FULL;");

    applyGeneratedMigrations(sqlite);
    const db = createDrizzleDb(sqlite);
    return createConnectedDb(sqlite, db, path);
  } catch (error) {
    sqlite.close();
    throw error;
  }
};

export const connectDb = async (dbPathOverride?: string): Promise<ConnectedDb> => {
  const dbPath = await resolveDbPath(dbPathOverride);
  await ensureParentDir(dbPath);

  try {
    return await initializeSqlite(dbPath);
  } catch (error) {
    throw new WachiError(
      `Failed to open database at ${dbPath}`,
      error instanceof Error ? error.message : "Could not open sqlite database.",
      "Check filesystem permissions or set WACHI_DB_PATH to a writable location.",
    );
  }
};
