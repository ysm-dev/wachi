import { access } from "node:fs/promises";
import { getEnv } from "../../utils/env.ts";
import { WachiError } from "../../utils/error.ts";
import { getPendingUpdatePath } from "../../utils/paths.ts";
import { VERSION } from "../../version.ts";
import { detectInstallMethod } from "./detect-method.ts";
import { downloadReleaseAsset, verifyFileSha256 } from "./download.ts";
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

  const checkedAt = new Date(now).toISOString();
  let latestRelease: Awaited<ReturnType<typeof fetchLatestRelease>>;
  try {
    latestRelease = await fetchLatestRelease(fetchFn);
  } catch (error) {
    await writeUpdateState({ ...(await readUpdateState()), lastCheckedAt: checkedAt });
    throw error;
  }

  if (!isNewerVersion(VERSION, latestRelease.version)) {
    await clearPendingUpdateState();
    await writeUpdateState({ lastCheckedAt: checkedAt });
    return;
  }

  if (!latestRelease.digest) {
    await writeUpdateState({ ...(await readUpdateState()), lastCheckedAt: checkedAt });
    throw new WachiError(
      "Update verification data is unavailable",
      "GitHub did not publish a SHA-256 digest for the release asset.",
      "Keep the current version and try again after the release metadata is complete.",
    );
  }

  const pendingPath = getPendingUpdatePath();
  const pending = state.pending;
  const updateAlreadyStaged = pending
    ? pending.version === latestRelease.version &&
      pending.targetPath === process.execPath &&
      pending.digest === latestRelease.digest &&
      (await fileExists(pendingPath)) &&
      (await verifyFileSha256(pendingPath, pending.digest))
    : false;

  if (!updateAlreadyStaged) {
    try {
      await downloadReleaseAsset(
        latestRelease.downloadUrl,
        pendingPath,
        fetchFn,
        process.platform,
        latestRelease.digest,
      );
    } catch (error) {
      await writeUpdateState({ ...(await readUpdateState()), lastCheckedAt: checkedAt });
      throw error;
    }
  }

  await writeUpdateState({
    lastCheckedAt: checkedAt,
    pending: {
      version: latestRelease.version,
      assetName: latestRelease.assetName,
      targetPath: process.execPath,
      digest: latestRelease.digest,
    },
  });
};
