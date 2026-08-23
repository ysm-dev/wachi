import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, open, rename, rm } from "node:fs/promises";
import { WachiError } from "../../utils/error.ts";
import { ensureParentDir } from "../../utils/paths.ts";
import { VERSION } from "../../version.ts";

const MAX_UPDATE_BYTES = 256 * 1024 * 1024;

const writeAll = async (
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new Error("Failed to write the downloaded update.");
    }
    offset += bytesWritten;
  }
};

const parseSha256Digest = (digest: string): string | null => {
  return /^sha256:([a-f\d]{64})$/i.exec(digest)?.[1]?.toLowerCase() ?? null;
};

export const verifyFileSha256 = async (
  filePath: string,
  expectedDigest: string,
): Promise<boolean> => {
  const expected = parseSha256Digest(expectedDigest);
  if (!expected) {
    return false;
  }
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk);
    }
  } catch {
    return false;
  }
  return hash.digest("hex") === expected;
};

export const downloadReleaseAsset = async (
  downloadUrl: string,
  targetPath: string,
  fetchFn: typeof fetch = globalThis.fetch,
  platform: NodeJS.Platform = process.platform,
  expectedDigest?: string,
): Promise<void> => {
  const expected = expectedDigest ? parseSha256Digest(expectedDigest) : null;
  if (expectedDigest && !expected) {
    throw new WachiError(
      "Downloaded update failed verification",
      "The release asset has an invalid SHA-256 digest.",
      "Try again later or download and verify the release asset manually.",
    );
  }
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
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPDATE_BYTES) {
    throw new WachiError(
      "Failed to download update",
      `The release asset exceeds the ${MAX_UPDATE_BYTES}-byte size limit.`,
      "Download and verify the release asset manually.",
    );
  }

  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  await ensureParentDir(targetPath);
  const hash = createHash("sha256");
  let totalBytes = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    if (!response.body) {
      throw new Error("Update response did not include a body.");
    }
    for await (const chunk of response.body) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_UPDATE_BYTES) {
        throw new WachiError(
          "Failed to download update",
          `The release asset exceeds the ${MAX_UPDATE_BYTES}-byte size limit.`,
          "Download and verify the release asset manually.",
        );
      }
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    await handle.close();
    handle = undefined;

    if (expected && hash.digest("hex") !== expected) {
      throw new WachiError(
        "Downloaded update failed verification",
        "The release asset did not match the SHA-256 digest published by GitHub.",
        "Try again later or download and verify the release asset manually.",
      );
    }

    if (platform !== "win32") {
      await chmod(temporaryPath, 0o755);
    }

    await rename(temporaryPath, targetPath);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
};
