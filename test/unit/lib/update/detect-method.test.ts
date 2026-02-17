import { describe, expect, it } from "bun:test";
import { detectInstallMethod } from "../../../../src/lib/update/detect-method.ts";

describe("detectInstallMethod", () => {
  it("detects npm installs", () => {
    expect(detectInstallMethod("/tmp/node_modules/.bin/wachi")).toBe("npm");
    expect(detectInstallMethod("/Users/me/.bun/bin/bun")).toBe("npm");
  });

  it("detects brew installs", () => {
    expect(detectInstallMethod("/opt/homebrew/Cellar/wachi/1.0.0/bin/wachi")).toBe("brew");
    expect(detectInstallMethod("/opt/homebrew/bin/wachi")).toBe("brew");
  });

  it("falls back to binary for unknown paths", () => {
    expect(detectInstallMethod("/usr/local/bin/wachi")).toBe("binary");
  });
});
