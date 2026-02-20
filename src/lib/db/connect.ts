import { Database } from "bun:sqlite";
import { access, rm } from "node:fs/promises";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getEnv } from "../../utils/env.ts";
import { WachiError } from "../../utils/error.ts";
import { ensureParentDir, getDefaultDbPath, getLegacyNodejsDbPath } from "../../utils/paths.ts";
import { generatedMigrations } from "./generated-migrations.ts";
import { dbSchema } from "./schema.ts";

const createDrizzleDb = (sqlite: Database) => {
  return drizzle({ client: sqlite, schema: dbSchema });
};

export type WachiDb = ReturnType<typeof createDrizzleDb>;

const createConnectedDb = (sqlite: Database, db: WachiDb, path: string) => {
  return { sqlite, db, path };
};

export type ConnectedDb = ReturnType<typeof createConnectedDb>;

const applyGeneratedMigrations = (sqlite: Database): void => {
  for (const sql of generatedMigrations) {
    sqlite.exec(sql);
  }
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

const migrateLegacyDbIfNeeded = async (canonicalDbPath: string): Promise<string> => {
  if (await pathExists(canonicalDbPath)) {
    return canonicalDbPath;
  }

  const legacyDbPath = getLegacyNodejsDbPath();
  if (!(await pathExists(legacyDbPath))) {
    return canonicalDbPath;
  }

  await ensureParentDir(canonicalDbPath);
  exportLegacyDb(legacyDbPath, canonicalDbPath);
  await removeDbFiles(legacyDbPath);
  process.stderr.write(
    `Warning: Migrated database from legacy runtime path to ${canonicalDbPath}.\n`,
  );
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
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");

  applyGeneratedMigrations(sqlite);
  const db = createDrizzleDb(sqlite);
  return createConnectedDb(sqlite, db, path);
};

export const connectDb = async (dbPathOverride?: string): Promise<ConnectedDb> => {
  const dbPath = await resolveDbPath(dbPathOverride);
  await ensureParentDir(dbPath);

  try {
    return await initializeSqlite(dbPath);
  } catch {
    try {
      await removeDbFiles(dbPath);
      const connection = await initializeSqlite(dbPath);
      process.stderr.write(
        "Warning: Database was corrupted and has been reset. Dedup history lost -- some items may be re-sent on next check.\n",
      );
      return connection;
    } catch (error) {
      throw new WachiError(
        `Failed to open database at ${dbPath}`,
        error instanceof Error ? error.message : "Could not open sqlite database.",
        "Check filesystem permissions or set WACHI_DB_PATH to a writable location.",
      );
    }
  }
};
