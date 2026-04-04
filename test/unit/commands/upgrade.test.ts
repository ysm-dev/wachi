import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { upgradeCommand } from "../../../src/commands/upgrade.ts";

type MockProc = {
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array>;
};

const output = {
  stdout: "",
  stderr: "",
};

const envSnapshot = {
  WACHI_WRAPPER_PATH: process.env.WACHI_WRAPPER_PATH,
  WACHI_PATHS_ROOT: process.env.WACHI_PATHS_ROOT,
};

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const originalExecPath = process.execPath;
const originalSpawn = Bun.spawn;
const originalFetch = globalThis.fetch;

let tempDir = "";

const releaseAssetName = (() => {
  const target = `${process.platform}-${process.arch}`;
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
      return "wachi-darwin-arm64";
  }
})();

const toStream = (value: string): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-upgrade-"));
  output.stdout = "";
  output.stderr = "";
  process.exitCode = undefined;
  process.env.WACHI_PATHS_ROOT = tempDir;
  delete process.env.WACHI_WRAPPER_PATH;

  process.stdout.write = ((chunk: unknown) => {
    output.stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    output.stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.execPath = originalExecPath;
  Bun.spawn = originalSpawn;
  globalThis.fetch = originalFetch;
  process.exitCode = undefined;
  process.env.WACHI_WRAPPER_PATH = envSnapshot.WACHI_WRAPPER_PATH;
  process.env.WACHI_PATHS_ROOT = envSnapshot.WACHI_PATHS_ROOT;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

const runUpgradeHandler = upgradeCommand.run as
  | ((ctx: { args: Record<string, unknown> }) => Promise<void>)
  | undefined;

const runUpgrade = async (args: Record<string, unknown>): Promise<void> => {
  if (!runUpgradeHandler) {
    return;
  }
  await runUpgradeHandler({ args });
};

describe("upgradeCommand", () => {
  it("uses npm for npm global installs", async () => {
    process.execPath = "/tmp/node_modules/@wachi-cli/darwin-arm64/bin/wachi";
    process.env.WACHI_WRAPPER_PATH = "/usr/local/lib/node_modules/wachi/bin/wachi.js";
    const commands: string[][] = [];
    Bun.spawn = ((command: string[]) => {
      commands.push(command);
      if (command.join(" ") === "npm root -g") {
        return {
          exited: Promise.resolve(0),
          stdout: toStream("/usr/local/lib/node_modules\n"),
        } as MockProc;
      }
      return { exited: Promise.resolve(0) } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await runUpgrade({ json: true });

    expect(process.exitCode).toBe(0);
    expect(commands).toEqual([
      ["npm", "root", "-g"],
      ["npm", "install", "-g", "wachi@latest"],
    ]);
    expect(JSON.parse(output.stdout.trim()).data.method).toBe("npm");
  });

  it("uses bun for bun global installs", async () => {
    process.execPath = "/tmp/node_modules/@wachi-cli/darwin-arm64/bin/wachi";
    process.env.WACHI_WRAPPER_PATH = join(
      homedir(),
      ".bun",
      "install",
      "global",
      "node_modules",
      "wachi",
      "bin",
      "wachi.js",
    );
    const commands: string[][] = [];
    Bun.spawn = ((command: string[]) => {
      commands.push(command);
      return { exited: Promise.resolve(0) } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await runUpgrade({ json: true });

    expect(process.exitCode).toBe(0);
    expect(commands).toEqual([["bun", "install", "-g", "wachi@latest"]]);
    expect(JSON.parse(output.stdout.trim()).data.method).toBe("bun");
  });

  it("uses brew for homebrew installs", async () => {
    process.execPath = "/opt/homebrew/Cellar/wachi/0.2.4/bin/wachi";
    const commands: string[][] = [];
    Bun.spawn = ((command: string[]) => {
      commands.push(command);
      return { exited: Promise.resolve(0) } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await runUpgrade({ json: true });

    expect(process.exitCode).toBe(0);
    expect(commands).toEqual([["brew", "upgrade", "wachi"]]);
    expect(JSON.parse(output.stdout.trim()).data.method).toBe("brew");
  });

  it("returns a clear error for npx installs", async () => {
    process.execPath = "/tmp/node_modules/@wachi-cli/darwin-arm64/bin/wachi";
    process.env.WACHI_WRAPPER_PATH = "/Users/me/.npm/_npx/123/node_modules/wachi/bin/wachi.js";

    await runUpgrade({ json: true });

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.what).toContain("ephemeral install");
  });

  it("upgrades standalone binaries from GitHub Releases", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(dirname(currentBinaryPath), { recursive: true });
    await writeFile(currentBinaryPath, "old-binary", "utf8");
    process.execPath = currentBinaryPath;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "v9.9.9",
            assets: [
              {
                name: releaseAssetName,
                browser_download_url: `https://example.com/${releaseAssetName}`,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("new-binary", { status: 200 });
    }) as unknown as typeof fetch;

    await runUpgrade({ json: true });

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.method).toBe("standalone");
    expect(payload.data.status).toBe("replaced");
    await expect(readFile(currentBinaryPath, "utf8")).resolves.toBe("new-binary");
    await expect(readFile(`${currentBinaryPath}.bak`, "utf8")).resolves.toBe("old-binary");
  });

  it("returns JSON error when the package-manager upgrade fails", async () => {
    process.execPath = "/tmp/node_modules/@wachi-cli/darwin-arm64/bin/wachi";
    process.env.WACHI_WRAPPER_PATH = "/usr/local/lib/node_modules/wachi/bin/wachi.js";
    Bun.spawn = ((command: string[]) => {
      if (command.join(" ") === "npm root -g") {
        return {
          exited: Promise.resolve(0),
          stdout: toStream("/usr/local/lib/node_modules\n"),
        } as MockProc;
      }
      return { exited: Promise.resolve(1) } as MockProc;
    }) as unknown as typeof Bun.spawn;

    await runUpgrade({ json: true });

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.what).toContain("Upgrade command failed");
  });

  it("prints text output when the standalone binary is already current", async () => {
    const currentBinaryPath = join(tempDir, "bin", "wachi");
    await mkdir(dirname(currentBinaryPath), { recursive: true });
    await writeFile(currentBinaryPath, "current-binary", "utf8");
    process.execPath = currentBinaryPath;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          tag_name: "v0.2.1",
          assets: [
            {
              name: releaseAssetName,
              browser_download_url: `https://example.com/${releaseAssetName}`,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await runUpgrade({});

    expect(process.exitCode).toBe(0);
    expect(output.stdout).toContain("Already up to date");
  });
});
