import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { upgradeCommand } from "../../../src/commands/upgrade.ts";

type MockProc = {
  exited: Promise<number>;
};

const output = {
  stdout: "",
  stderr: "",
};

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const originalExecPath = process.execPath;
const originalSpawn = Bun.spawn;

beforeEach(() => {
  output.stdout = "";
  output.stderr = "";
  process.exitCode = undefined;

  process.stdout.write = ((chunk: unknown) => {
    output.stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    output.stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.execPath = originalExecPath;
  Bun.spawn = originalSpawn;
  process.exitCode = undefined;
});

const setSpawnExitCode = (code: number): void => {
  Bun.spawn = (() => {
    return { exited: Promise.resolve(code) } as MockProc;
  }) as unknown as typeof Bun.spawn;
};

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
  it("returns JSON success for npm install method", async () => {
    process.execPath = "/tmp/node_modules/.bin/node";
    setSpawnExitCode(0);

    await runUpgrade({ json: true });

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.method).toBe("npm");
  });

  it("returns JSON success for brew install method", async () => {
    process.execPath = "/opt/homebrew/Cellar/wachi/bin/wachi";
    setSpawnExitCode(0);

    await runUpgrade({ json: true });

    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.method).toBe("brew");
  });

  it("returns JSON error for standalone binary method", async () => {
    process.execPath = "/usr/local/bin/wachi";

    await runUpgrade({ json: true });

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.what).toContain("Automatic upgrade for standalone binary");
  });

  it("returns JSON error when upgrade command exits non-zero", async () => {
    process.execPath = "/tmp/node_modules/.bin/node";
    setSpawnExitCode(1);

    await runUpgrade({ json: true });

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.what).toContain("Upgrade command failed");
  });

  it("prints text success output when json mode is disabled", async () => {
    process.execPath = "/tmp/node_modules/.bin/node";
    setSpawnExitCode(0);

    await runUpgrade({});

    expect(process.exitCode).toBe(0);
    expect(output.stdout).toContain("Upgrade complete via npm.");
  });
});
