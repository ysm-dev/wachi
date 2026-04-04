import { describe, expect, it } from "bun:test";
import { detectInstallMethod } from "../../../../src/lib/update/detect-method.ts";

const passthroughRealPath = async (filePath: string): Promise<string> => filePath;

describe("detectInstallMethod", () => {
  it("detects npm global installs from wrapper path", async () => {
    await expect(
      detectInstallMethod({
        execPath: "/tmp/node_modules/@wachi-cli/darwin-arm64/bin/wachi",
        wrapperPath: "/usr/local/lib/node_modules/wachi/bin/wachi.js",
        npmGlobalRoot: "/usr/local/lib/node_modules",
        readRealPath: passthroughRealPath,
      }),
    ).resolves.toBe("npm");
  });

  it("detects bun global installs from bun install root", async () => {
    await expect(
      detectInstallMethod({
        execPath: "/tmp/node_modules/@wachi-cli/darwin-arm64/bin/wachi",
        wrapperPath: "/Users/me/.bun/install/global/node_modules/wachi/bin/wachi.js",
        bunInstallRoot: "/Users/me/.bun",
        readRealPath: passthroughRealPath,
      }),
    ).resolves.toBe("bun");
  });

  it("detects npx and bunx cache installs", async () => {
    await expect(
      detectInstallMethod({
        execPath: "/tmp/wachi",
        wrapperPath: "/Users/me/.npm/_npx/123/node_modules/wachi/bin/wachi.js",
        readRealPath: passthroughRealPath,
      }),
    ).resolves.toBe("npx");

    await expect(
      detectInstallMethod({
        execPath: "/tmp/wachi",
        wrapperPath: "/Users/me/.bun/install/cache/wachi@0.2.4@@@1/node_modules/wachi/bin/wachi.js",
        bunInstallRoot: "/Users/me/.bun",
        readRealPath: passthroughRealPath,
      }),
    ).resolves.toBe("bunx");
  });

  it("detects brew installs from the real executable path", async () => {
    await expect(
      detectInstallMethod({
        execPath: "/opt/homebrew/bin/wachi",
        readRealPath: async () => "/opt/homebrew/Cellar/wachi/0.2.4/bin/wachi",
      }),
    ).resolves.toBe("brew");
  });

  it("treats unresolved node_modules wrappers as project installs", async () => {
    await expect(
      detectInstallMethod({
        execPath: "/tmp/node_modules/@wachi-cli/darwin-arm64/bin/wachi",
        wrapperPath: "/Users/me/project/node_modules/wachi/bin/wachi.js",
        readRealPath: passthroughRealPath,
      }),
    ).resolves.toBe("project");
  });

  it("falls back to standalone for direct binaries", async () => {
    await expect(
      detectInstallMethod({
        execPath: "/Users/me/.local/bin/wachi",
        readRealPath: passthroughRealPath,
      }),
    ).resolves.toBe("standalone");
  });
});
