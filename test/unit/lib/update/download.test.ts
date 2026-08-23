import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadReleaseAsset } from "../../../../src/lib/update/download.ts";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-download-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("downloadReleaseAsset", () => {
  it("accepts an asset matching GitHub's SHA-256 digest", async () => {
    const contents = "verified-binary";
    const digest = createHash("sha256").update(contents).digest("hex");
    const targetPath = join(tempDir, "wachi-new");
    const fetchMock = (async () => new Response(contents)) as unknown as typeof fetch;

    await downloadReleaseAsset(
      "https://example.com/wachi",
      targetPath,
      fetchMock,
      "linux",
      `sha256:${digest}`,
    );

    await expect(readFile(targetPath, "utf8")).resolves.toBe(contents);
  });

  it("rejects an asset that does not match the published digest", async () => {
    const targetPath = join(tempDir, "wachi-new");
    const fetchMock = (async () => new Response("tampered")) as unknown as typeof fetch;

    await expect(
      downloadReleaseAsset(
        "https://example.com/wachi",
        targetPath,
        fetchMock,
        "linux",
        `sha256:${"0".repeat(64)}`,
      ),
    ).rejects.toThrow("Downloaded update failed verification");
    await expect(readFile(targetPath)).rejects.toBeInstanceOf(Error);
  });

  it("rejects an oversized asset before reading its body", async () => {
    const targetPath = join(tempDir, "wachi-new");
    const fetchMock = (async () =>
      new Response("small body", {
        headers: { "content-length": String(256 * 1024 * 1024 + 1) },
      })) as unknown as typeof fetch;

    await expect(
      downloadReleaseAsset("https://example.com/wachi", targetPath, fetchMock),
    ).rejects.toThrow("Failed to download update");
    await expect(readFile(targetPath)).rejects.toBeInstanceOf(Error);
  });
});
