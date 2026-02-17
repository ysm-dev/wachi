import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runCli = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = (await proc.exited) ?? 1;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
};

const testDirs: string[] = [];

afterEach(async () => {
  for (const dir of testDirs.splice(0, testDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("wachi CLI JSON/error behavior", () => {
  it("returns JSON error envelope for invalid apprise URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-json-error-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");

    const result = await runCli(
      ["sub", "--json", "invalid-apprise-url", "https://example.com", "--config", configPath],
      { WACHI_NO_AUTO_UPDATE: "1" },
    );

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error.what).toContain("Invalid apprise URL");
    expect(typeof payload.error.fix).toBe("string");
  });

  it("falls back to default concurrency when an invalid number is passed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-concurrency-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");

    const result = await runCli(
      ["check", "--json", "--concurrency", "-5", "--config", configPath],
      { WACHI_DB_PATH: dbPath, WACHI_NO_AUTO_UPDATE: "1" },
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data.sent).toEqual([]);
    expect(payload.data.skipped).toBe(0);
    expect(payload.data.errors).toEqual([]);
  });

  it("returns removed: 0 for missing channel in JSON unsub", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-unsub-json-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");

    const result = await runCli(
      ["unsub", "--json", "slack://token/channel", "--config", configPath],
      { WACHI_NO_AUTO_UPDATE: "1" },
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data.removed).toBe(0);
  });
});
