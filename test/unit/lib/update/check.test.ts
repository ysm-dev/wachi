import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageAutoUpdateIfNeeded } from "../../../../src/lib/update/check.ts";
import { readUpdateState } from "../../../../src/lib/update/state.ts";
import { getPendingUpdatePath } from "../../../../src/utils/paths.ts";

let tempDir = "";

const releaseAssetName = (() => {
  const target = `${process.platform}-${process.arch}`;
  switch (target) {
    case "darwin-arm64":
      return "wachi-darwin-arm64";
    case "darwin-x64":
      return "wachi-darwin-x64";
    case "linux-arm64":
      return "wachi-linux-arm64";
    case "linux-x64":
      return "wachi-linux-x64";
    case "win32-x64":
      return "wachi-win32-x64.exe";
    default:
      return "wachi-darwin-arm64";
  }
})();

const envSnapshot = {
  WACHI_PATHS_ROOT: process.env.WACHI_PATHS_ROOT,
  WACHI_WRAPPER_PATH: process.env.WACHI_WRAPPER_PATH,
  WACHI_NO_AUTO_UPDATE: process.env.WACHI_NO_AUTO_UPDATE,
};

const originalExecPath = process.execPath;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-update-check-"));
  process.env.WACHI_PATHS_ROOT = tempDir;
  delete process.env.WACHI_WRAPPER_PATH;
  delete process.env.WACHI_NO_AUTO_UPDATE;
  process.execPath = join(tempDir, "bin", "wachi");
});

afterEach(async () => {
  process.execPath = originalExecPath;
  process.env.WACHI_PATHS_ROOT = envSnapshot.WACHI_PATHS_ROOT;
  process.env.WACHI_WRAPPER_PATH = envSnapshot.WACHI_WRAPPER_PATH;
  process.env.WACHI_NO_AUTO_UPDATE = envSnapshot.WACHI_NO_AUTO_UPDATE;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("stageAutoUpdateIfNeeded", () => {
  it("downloads and records a newer standalone update", async () => {
    let calls = 0;
    const fetchMock = (async (input: string | URL | Request) => {
      calls += 1;
      const url = String(input);
      if (url.includes("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "v9.9.9",
            assets: [
              {
                name: releaseAssetName,
                browser_download_url: `https://example.com/${releaseAssetName}`,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("new-binary", { status: 200 });
    }) as unknown as typeof fetch;

    await stageAutoUpdateIfNeeded(fetchMock, Date.UTC(2026, 0, 1));

    expect(calls).toBe(2);
    await expect(readFile(getPendingUpdatePath(), "utf8")).resolves.toBe("new-binary");
    const state = await readUpdateState();
    expect(typeof state.lastCheckedAt).toBe("string");
    expect(state.pending).toEqual({
      version: "9.9.9",
      assetName: releaseAssetName,
      targetPath: process.execPath,
    });
  });

  it("skips network work during the cooldown window", async () => {
    const fetchMock = (() => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;

    await stageAutoUpdateIfNeeded(
      (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/releases/latest")) {
          return new Response(
            JSON.stringify({
              tag_name: "v9.9.9",
              assets: [
                {
                  name: releaseAssetName,
                  browser_download_url: `https://example.com/${releaseAssetName}`,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response("new-binary", { status: 200 });
      }) as unknown as typeof fetch,
      Date.UTC(2026, 0, 1),
    );

    await expect(
      stageAutoUpdateIfNeeded(fetchMock, Date.UTC(2026, 0, 1) + 60_000),
    ).resolves.toBeUndefined();
  });

  it("skips auto update for wrapped installs", async () => {
    process.env.WACHI_WRAPPER_PATH = "/Users/me/project/node_modules/wachi/bin/wachi.js";
    const fetchMock = (() => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;

    await expect(stageAutoUpdateIfNeeded(fetchMock)).resolves.toBeUndefined();
    await expect(readUpdateState()).resolves.toEqual({});
  });
});
