import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyPendingAutoUpdate } from "../../../../src/lib/update/apply.ts";
import { readUpdateState, writeUpdateState } from "../../../../src/lib/update/state.ts";
import { getPendingUpdatePath } from "../../../../src/utils/paths.ts";

let tempDir = "";

const envSnapshot = {
  WACHI_PATHS_ROOT: process.env.WACHI_PATHS_ROOT,
  WACHI_WRAPPER_PATH: process.env.WACHI_WRAPPER_PATH,
};

const originalExecPath = process.execPath;

const stagePendingUpdate = async (targetPath: string): Promise<void> => {
  const pendingPath = getPendingUpdatePath();
  await mkdir(dirname(pendingPath), { recursive: true });
  await writeFile(pendingPath, "new-binary", "utf8");
  await writeUpdateState({
    lastCheckedAt: new Date().toISOString(),
    pending: {
      version: "9.9.9",
      assetName: "wachi-darwin-arm64",
      targetPath,
    },
  });
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-update-"));
  process.env.WACHI_PATHS_ROOT = tempDir;
  delete process.env.WACHI_WRAPPER_PATH;
});

afterEach(async () => {
  process.execPath = originalExecPath;
  process.env.WACHI_PATHS_ROOT = envSnapshot.WACHI_PATHS_ROOT;
  process.env.WACHI_WRAPPER_PATH = envSnapshot.WACHI_WRAPPER_PATH;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("applyPendingAutoUpdate", () => {
  it("returns false when no pending update exists", async () => {
    process.execPath = join(tempDir, "bin", "wachi");

    const applied = await applyPendingAutoUpdate();
    expect(applied).toBe(false);
  });

  it("returns false when running through a package wrapper", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(dirname(currentBinaryPath), { recursive: true });
    await writeFile(currentBinaryPath, "old-binary", "utf8");
    await stagePendingUpdate(currentBinaryPath);
    process.env.WACHI_WRAPPER_PATH = "/usr/local/lib/node_modules/wachi/bin/wachi.js";
    process.execPath = currentBinaryPath;

    const applied = await applyPendingAutoUpdate();

    expect(applied).toBe(false);
    await expect(readFile(currentBinaryPath, "utf8")).resolves.toBe("old-binary");
  });

  it("clears stale pending state when the staged binary is missing", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await writeUpdateState({
      lastCheckedAt: new Date().toISOString(),
      pending: {
        version: "9.9.9",
        assetName: "wachi-darwin-arm64",
        targetPath: currentBinaryPath,
      },
    });
    process.execPath = currentBinaryPath;

    const applied = await applyPendingAutoUpdate();

    expect(applied).toBe(false);
    const state = await readUpdateState();
    expect(typeof state.lastCheckedAt).toBe("string");
    expect(state.pending).toBeUndefined();
  });

  it("applies pending binary and keeps backup", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(dirname(currentBinaryPath), { recursive: true });
    await writeFile(currentBinaryPath, "old-binary", "utf8");
    await stagePendingUpdate(currentBinaryPath);
    process.execPath = currentBinaryPath;

    const applied = await applyPendingAutoUpdate();

    expect(applied).toBe(true);
    await expect(readFile(`${currentBinaryPath}.bak`, "utf8")).resolves.toBe("old-binary");
    await expect(readFile(currentBinaryPath, "utf8")).resolves.toBe("new-binary");

    const mode = (await stat(currentBinaryPath)).mode & 0o777;
    expect(mode).toBe(0o755);
    const state = await readUpdateState();
    expect(typeof state.lastCheckedAt).toBe("string");
    expect(state.pending).toBeUndefined();
  });

  it("propagates fs errors when the target binary cannot be replaced", async () => {
    const currentBinaryPath = join(tempDir, "bin", "missing", "wachi");
    await stagePendingUpdate(currentBinaryPath);
    process.execPath = currentBinaryPath;

    await expect(applyPendingAutoUpdate()).rejects.toBeInstanceOf(Error);
  });
});
