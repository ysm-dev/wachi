import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import { VERSION } from "../../version.ts";

const RELEASE_API_URL = "https://api.github.com/repos/ysm-dev/wachi/releases/latest";

const releaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string().url(),
    }),
  ),
});

const resolveAssetName = (platform: NodeJS.Platform, arch: string): string => {
  const target = `${platform}-${arch}`;
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
      throw new WachiError(
        "Automatic upgrade is not supported on this platform",
        `No release asset is published for ${platform}/${arch}.`,
        "Install a supported build or upgrade manually from the release assets.",
      );
  }
};

export const fetchLatestRelease = async (
  fetchFn: typeof fetch = globalThis.fetch,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): Promise<{ version: string; assetName: string; downloadUrl: string }> => {
  const assetName = resolveAssetName(platform, arch);
  const response = await fetchFn(RELEASE_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `wachi/${VERSION}`,
    },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new WachiError(
      "Failed to check for updates",
      `GitHub Releases responded with HTTP ${response.status}.`,
      "Try again later or check your network connection.",
    );
  }

  const parsed = releaseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new WachiError(
      "Failed to parse update metadata",
      "GitHub Releases returned an unexpected response shape.",
      "Try again later or upgrade manually from the latest release page.",
    );
  }

  const asset = parsed.data.assets.find((entry) => entry.name === assetName);
  if (!asset) {
    throw new WachiError(
      "No release asset found for this platform",
      `The latest release does not include ${assetName}.`,
      "Try again later or download the correct binary manually from GitHub Releases.",
    );
  }

  return {
    version: parsed.data.tag_name.replace(/^v/, ""),
    assetName,
    downloadUrl: asset.browser_download_url,
  };
};
