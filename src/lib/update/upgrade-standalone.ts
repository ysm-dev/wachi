import { WachiError } from "../../utils/error.ts";
import { getPendingUpdatePath, getPendingUpdateStatePath } from "../../utils/paths.ts";
import { VERSION } from "../../version.ts";
import { acquireUpdateApplyLock, replaceStandaloneBinary } from "./apply.ts";
import { downloadReleaseAsset, verifyFileSha256 } from "./download.ts";
import { fetchLatestRelease } from "./release.ts";
import { clearPendingUpdateState, writeUpdateState } from "./state.ts";
import { isNewerVersion } from "./version.ts";

export const upgradeStandaloneInstall = async (
  fetchFn: typeof fetch = globalThis.fetch,
  platform: NodeJS.Platform = process.platform,
): Promise<{
  upgraded: boolean;
  version: string;
  status: "current" | "replaced" | "scheduled";
}> => {
  const latestRelease = await fetchLatestRelease(fetchFn, platform);
  const checkedAt = new Date().toISOString();

  if (!isNewerVersion(VERSION, latestRelease.version)) {
    await clearPendingUpdateState();
    await writeUpdateState({ lastCheckedAt: checkedAt });
    return { upgraded: false, version: VERSION, status: "current" };
  }

  const lock = await acquireUpdateApplyLock();
  if (!lock) {
    throw new WachiError(
      "Another update is already in progress",
      "A different wachi process is applying an update.",
      "Wait for the other process to finish, then try again.",
    );
  }

  let lockTransferred = false;
  try {
    if (!latestRelease.digest) {
      throw new WachiError(
        "Update verification data is unavailable",
        "GitHub did not publish a SHA-256 digest for the release asset.",
        "Keep the current version and try again after the release metadata is complete.",
      );
    }
    const pendingPath = getPendingUpdatePath();
    await downloadReleaseAsset(
      latestRelease.downloadUrl,
      pendingPath,
      fetchFn,
      platform,
      latestRelease.digest,
    );
    if (!(await verifyFileSha256(pendingPath, latestRelease.digest))) {
      await clearPendingUpdateState();
      throw new WachiError(
        "Staged update failed verification",
        "The downloaded release asset changed after it was staged.",
        "Run the upgrade again to download a verified update.",
      );
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

    const outcome = await replaceStandaloneBinary(
      process.execPath,
      pendingPath,
      platform,
      getPendingUpdateStatePath(),
      lock.path,
    );

    if (outcome === "replaced") {
      await clearPendingUpdateState();
    } else {
      lockTransferred = true;
    }

    return {
      upgraded: true,
      version: latestRelease.version,
      status: outcome,
    };
  } finally {
    if (!lockTransferred) {
      await lock.release();
    }
  }
};
