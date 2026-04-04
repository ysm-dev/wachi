import { getPendingUpdatePath, getPendingUpdateStatePath } from "../../utils/paths.ts";
import { VERSION } from "../../version.ts";
import { replaceStandaloneBinary } from "./apply.ts";
import { downloadReleaseAsset } from "./download.ts";
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

  const pendingPath = getPendingUpdatePath();
  await downloadReleaseAsset(latestRelease.downloadUrl, pendingPath, fetchFn, platform);
  await writeUpdateState({
    lastCheckedAt: checkedAt,
    pending: {
      version: latestRelease.version,
      assetName: latestRelease.assetName,
      targetPath: process.execPath,
    },
  });

  const outcome = await replaceStandaloneBinary(
    process.execPath,
    pendingPath,
    platform,
    getPendingUpdateStatePath(),
  );

  if (outcome === "replaced") {
    await clearPendingUpdateState();
  }

  return {
    upgraded: true,
    version: latestRelease.version,
    status: outcome,
  };
};
