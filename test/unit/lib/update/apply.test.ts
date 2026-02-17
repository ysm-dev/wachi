import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyPendingAutoUpdate } from "../../../../src/lib/update/apply.ts";
import { getPendingUpdatePath } from "../../../../src/utils/paths.ts";

let tempDir = "";

const envSnapshot = {
  HOME: process.env.HOME,
};

const originalExecPath = process.execPath;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-update-"));
  process.env.HOME = tempDir;
});

afterEach(async () => {
  process.execPath = originalExecPath;
  process.env.HOME = envSnapshot.HOME;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("applyPendingAutoUpdate", () => {
  it("returns false when no pending update exists", async () => {
    const pendingPath = getPendingUpdatePath();
    await rm(pendingPath, { force: true });
    process.execPath = join(tempDir, "bin", "wachi");

    const applied = await applyPendingAutoUpdate();
    expect(applied).toBe(false);
  });

  it("returns false when running under bun", async () => {
    const pendingPath = getPendingUpdatePath();
    await mkdir(dirname(pendingPath), { recursive: true });
    await writeFile(pendingPath, "new-binary", "utf8");

    process.execPath = "/Users/me/.bun/bin/bun";

    const applied = await applyPendingAutoUpdate();
    expect(applied).toBe(false);
  });

  it("applies pending binary and keeps backup", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(join(currentBinaryPath, ".."), { recursive: true });
    await writeFile(currentBinaryPath, "old-binary", "utf8");

    const pendingPath = getPendingUpdatePath();
    await mkdir(dirname(pendingPath), { recursive: true });
    await writeFile(pendingPath, "new-binary", "utf8");

    process.execPath = currentBinaryPath;

    const applied = await applyPendingAutoUpdate();

    expect(applied).toBe(true);
    await expect(readFile(`${currentBinaryPath}.bak`, "utf8")).resolves.toBe("old-binary");
    await expect(readFile(currentBinaryPath, "utf8")).resolves.toBe("new-binary");

    const mode = (await stat(currentBinaryPath)).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("propagates fs errors when rename fails", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(join(currentBinaryPath, ".."), { recursive: true });
    await writeFile(currentBinaryPath, "old-binary", "utf8");
    await chmod(currentBinaryPath, 0o444);

    const pendingPath = getPendingUpdatePath();
    await mkdir(dirname(pendingPath), { recursive: true });
    await writeFile(pendingPath, "new-binary", "utf8");

    process.execPath = join(currentBinaryPath, "..", "missing", "wachi");

    await expect(applyPendingAutoUpdate()).rejects.toBeInstanceOf(Error);
  });
});
