import { access } from "node:fs/promises";
import { getEnv } from "../../utils/env.ts";
import { getPendingUpdatePath } from "../../utils/paths.ts";
import { VERSION } from "../../version.ts";
import { detectInstallMethod } from "./detect-method.ts";
import { downloadReleaseAsset } from "./download.ts";
import { fetchLatestRelease } from "./release.ts";
import { clearPendingUpdateState, readUpdateState, writeUpdateState } from "./state.ts";
import { isNewerVersion } from "./version.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const stageAutoUpdateIfNeeded = async (
  fetchFn: typeof fetch = globalThis.fetch,
  now = Date.now(),
): Promise<void> => {
  const env = getEnv();
  if (env.noAutoUpdate) {
    return;
  }

  if ((await detectInstallMethod()) !== "standalone") {
    return;
  }

  const state = await readUpdateState();
  if (state.lastCheckedAt) {
    const lastCheckedAt = Date.parse(state.lastCheckedAt);
    if (!Number.isNaN(lastCheckedAt) && now - lastCheckedAt < ONE_DAY_MS) {
      return;
    }
  }

  const latestRelease = await fetchLatestRelease(fetchFn);
  const checkedAt = new Date(now).toISOString();
  if (!isNewerVersion(VERSION, latestRelease.version)) {
    await clearPendingUpdateState();
    await writeUpdateState({ lastCheckedAt: checkedAt });
    return;
  }

  const pendingPath = getPendingUpdatePath();
  const pending = state.pending;
  const updateAlreadyStaged = pending
    ? pending.version === latestRelease.version &&
      pending.targetPath === process.execPath &&
      (await fileExists(pendingPath))
    : false;

  if (!updateAlreadyStaged) {
    await downloadReleaseAsset(latestRelease.downloadUrl, pendingPath, fetchFn);
  }

  await writeUpdateState({
    lastCheckedAt: checkedAt,
    pending: {
      version: latestRelease.version,
      assetName: latestRelease.assetName,
      targetPath: process.execPath,
    },
  });
};
