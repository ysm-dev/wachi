import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { WachiError } from "../../utils/error.ts";
import { ensureParentDir } from "../../utils/paths.ts";
import { VERSION } from "../../version.ts";

export const downloadReleaseAsset = async (
  downloadUrl: string,
  targetPath: string,
  fetchFn: typeof fetch = globalThis.fetch,
  platform: NodeJS.Platform = process.platform,
): Promise<void> => {
  const response = await fetchFn(downloadUrl, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": `wachi/${VERSION}`,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new WachiError(
      "Failed to download update",
      `GitHub Releases responded with HTTP ${response.status}.`,
      "Try again later or download the release asset manually.",
    );
  }

  const temporaryPath = `${targetPath}.tmp`;
  await ensureParentDir(targetPath);
  await rm(temporaryPath, { force: true });
  await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));

  if (platform !== "win32") {
    await chmod(temporaryPath, 0o755);
  }

  await rename(temporaryPath, targetPath);
};
