import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import { sentItems } from "../../../../src/lib/db/schema.ts";
import { WachiError } from "../../../../src/utils/error.ts";

let tempDir = "";
let connection: ConnectedDb | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-db-connect-"));
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
});
