import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureParentDir,
  getDefaultConfigPath,
  getDefaultDbPath,
  getDefaultJsonConfigPath,
  getDefaultJsoncConfigPath,
  getLegacyNodejsDbPath,
  getPendingUpdatePath,
} from "../../../src/utils/paths.ts";

const envSnapshot = {
  WACHI_CONFIG_PATH: process.env.WACHI_CONFIG_PATH,
  WACHI_DB_PATH: process.env.WACHI_DB_PATH,
  WACHI_PATHS_ROOT: process.env.WACHI_PATHS_ROOT,
};

let pathsRoot = "";

beforeEach(async () => {
  pathsRoot = await mkdtemp(join(tmpdir(), "wachi-paths-home-"));
  process.env.WACHI_PATHS_ROOT = pathsRoot;
});

afterEach(async () => {
  process.env.WACHI_CONFIG_PATH = envSnapshot.WACHI_CONFIG_PATH;
  process.env.WACHI_DB_PATH = envSnapshot.WACHI_DB_PATH;
  process.env.WACHI_PATHS_ROOT = envSnapshot.WACHI_PATHS_ROOT;
  if (pathsRoot) {
    await rm(pathsRoot, { recursive: true, force: true });
    pathsRoot = "";
  }
});

describe("paths", () => {
  it("uses env override for config and db paths", () => {
    process.env.WACHI_CONFIG_PATH = "/tmp/custom-config.yml";
    process.env.WACHI_DB_PATH = "/tmp/custom.db";

    expect(getDefaultConfigPath()).toBe("/tmp/custom-config.yml");
    expect(getDefaultDbPath()).toBe("/tmp/custom.db");
  });

  it("returns default file names for derived paths", () => {
    delete process.env.WACHI_CONFIG_PATH;
    delete process.env.WACHI_DB_PATH;

    expect(getDefaultConfigPath().startsWith(pathsRoot)).toBe(true);
    expect(getDefaultConfigPath().endsWith("config.yml")).toBe(true);
    expect(getDefaultJsoncConfigPath().endsWith("config.jsonc")).toBe(true);
    expect(getDefaultJsonConfigPath().endsWith("config.json")).toBe(true);
    expect(getDefaultDbPath().endsWith("wachi.db")).toBe(true);
    expect(getPendingUpdatePath().endsWith("wachi-new")).toBe(true);
  });

  it("derives legacy nodejs db path", () => {
    const legacyDbPath = getLegacyNodejsDbPath();
    expect(legacyDbPath.endsWith("wachi.db")).toBe(true);
    expect(legacyDbPath.toLowerCase().includes("wachi-nodejs")).toBe(true);
  });

  it("creates parent directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-paths-"));
    const target = join(dir, "nested", "file.txt");
    await ensureParentDir(target);

    const info = await stat(join(dir, "nested"));
    expect(info.isDirectory()).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});
