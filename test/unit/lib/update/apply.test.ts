import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyPendingAutoUpdate,
  replaceStandaloneBinary,
} from "../../../../src/lib/update/apply.ts";
import { readUpdateState, writeUpdateState } from "../../../../src/lib/update/state.ts";
import { getPendingUpdatePath, getPendingUpdateScriptPath } from "../../../../src/utils/paths.ts";
import { VERSION } from "../../../../src/version.ts";

let tempDir = "";

const envSnapshot = {
  WACHI_PATHS_ROOT: process.env.WACHI_PATHS_ROOT,
  WACHI_WRAPPER_PATH: process.env.WACHI_WRAPPER_PATH,
  WACHI_NO_AUTO_UPDATE: process.env.WACHI_NO_AUTO_UPDATE,
};

const originalExecPath = process.execPath;
const originalSpawn = Bun.spawn;

const stagePendingUpdate = async (targetPath: string, version = "9.9.9"): Promise<void> => {
  const pendingPath = getPendingUpdatePath();
  await mkdir(dirname(pendingPath), { recursive: true });
  await writeFile(pendingPath, "new-binary", "utf8");
  await writeUpdateState({
    lastCheckedAt: new Date().toISOString(),
    pending: {
      version,
      assetName: "wachi-darwin-arm64",
      targetPath,
      digest: `sha256:${createHash("sha256").update("new-binary").digest("hex")}`,
    },
  });
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-update-"));
  process.env.WACHI_PATHS_ROOT = tempDir;
  delete process.env.WACHI_WRAPPER_PATH;
  delete process.env.WACHI_NO_AUTO_UPDATE;
});

afterEach(async () => {
  process.execPath = originalExecPath;
  Bun.spawn = originalSpawn;
  process.env.WACHI_PATHS_ROOT = envSnapshot.WACHI_PATHS_ROOT;
  process.env.WACHI_WRAPPER_PATH = envSnapshot.WACHI_WRAPPER_PATH;
  process.env.WACHI_NO_AUTO_UPDATE = envSnapshot.WACHI_NO_AUTO_UPDATE;
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

  it("does not apply a staged update when auto updates are disabled", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(dirname(currentBinaryPath), { recursive: true });
    await writeFile(currentBinaryPath, "old-binary", "utf8");
    await stagePendingUpdate(currentBinaryPath);
    process.env.WACHI_NO_AUTO_UPDATE = "1";
    process.execPath = currentBinaryPath;

    expect(await applyPendingAutoUpdate()).toBe(false);
    await expect(readFile(currentBinaryPath, "utf8")).resolves.toBe("old-binary");
    expect((await readUpdateState()).pending?.version).toBe("9.9.9");
  });

  it("discards a staged version that is not newer than the running version", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(dirname(currentBinaryPath), { recursive: true });
    await writeFile(currentBinaryPath, "current-binary", "utf8");
    await stagePendingUpdate(currentBinaryPath, VERSION);
    process.execPath = currentBinaryPath;

    expect(await applyPendingAutoUpdate()).toBe(false);
    await expect(readFile(currentBinaryPath, "utf8")).resolves.toBe("current-binary");
    expect((await readUpdateState()).pending).toBeUndefined();
  });

  it("clears stale pending state when the staged binary is missing", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await writeUpdateState({
      lastCheckedAt: new Date().toISOString(),
      pending: {
        version: "9.9.9",
        assetName: "wachi-darwin-arm64",
        targetPath: currentBinaryPath,
        digest: `sha256:${"0".repeat(64)}`,
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

  it("allows only one concurrent caller to apply a staged update", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(dirname(currentBinaryPath), { recursive: true });
    await writeFile(currentBinaryPath, "old-binary", "utf8");
    await stagePendingUpdate(currentBinaryPath);
    process.execPath = currentBinaryPath;

    const outcomes = await Promise.all([applyPendingAutoUpdate(), applyPendingAutoUpdate()]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await expect(readFile(currentBinaryPath, "utf8")).resolves.toBe("new-binary");
  });

  it("rejects a staged binary that changed after download", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(dirname(currentBinaryPath), { recursive: true });
    await writeFile(currentBinaryPath, "old-binary", "utf8");
    await stagePendingUpdate(currentBinaryPath);
    await writeFile(getPendingUpdatePath(), "tampered-binary", "utf8");
    process.execPath = currentBinaryPath;

    await expect(applyPendingAutoUpdate()).rejects.toThrow("Staged update failed verification");

    await expect(readFile(currentBinaryPath, "utf8")).resolves.toBe("old-binary");
    expect((await readUpdateState()).pending).toBeUndefined();
  });

  it("writes a terminating Windows helper that restores backups on replacement failure", async () => {
    let spawnedCommand: string[] = [];
    Bun.spawn = ((command: string[]) => {
      spawnedCommand = command;
      return { exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;

    await replaceStandaloneBinary(
      "C:\\Program Files\\wachi\\wachi.exe",
      "C:\\Users\\A User\\wachi-new.exe",
      "win32",
      "C:\\Users\\A User\\state.json",
    );

    const script = await readFile(getPendingUpdateScriptPath(), "utf8");
    expect(script).toContain('$ErrorActionPreference = "Stop"');
    expect(script).toContain("Copy-Item -Force $BackupPath $TargetPath -ErrorAction Stop");
    expect(script).toContain("-not $replacementSucceeded");
    expect(script).toContain("Remove-Item $StatePath -Force -ErrorAction Stop");
    expect(script.indexOf("$replacementSucceeded = $true")).toBeLessThan(
      script.indexOf("Remove-Item $StatePath"),
    );
    expect(spawnedCommand.join(" ")).toContain(`'"C:\\Program Files\\wachi\\wachi.exe"'`);
    expect(spawnedCommand.join(" ")).toContain(`'"C:\\Users\\A User\\wachi-new.exe"'`);
  });

  it("propagates fs errors when the target binary cannot be replaced", async () => {
    const currentBinaryPath = join(tempDir, "bin", "missing", "wachi");
    await stagePendingUpdate(currentBinaryPath);
    process.execPath = currentBinaryPath;

    await expect(applyPendingAutoUpdate()).rejects.toBeInstanceOf(Error);
  });
});
