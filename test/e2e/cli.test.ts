import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../src/version.ts";

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

const createFeed = (title: string, link: string): string => {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test Feed</title>
<item><title>${title}</title><link>${link}</link><guid>${link}</guid></item>
</channel></rss>`;
};

const testDirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }
  for (const dir of testDirs.splice(0, testDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("wachi CLI", () => {
  it("prints version", async () => {
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(VERSION);
  });

  it("prints empty ls JSON for new config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-empty-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");

    const result = await runCli(["ls", "--json", "--config", configPath], {
      WACHI_DB_PATH: dbPath,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.channels).toEqual([]);
  });

  it("supports subscribe/check/unsubscribe flow for RSS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-flow-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");

    let feedXml = createFeed("Item 1", "https://example.com/1");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/feed.xml") {
          return new Response(feedXml, {
            headers: { "content-type": "application/rss+xml" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const feedUrl = `http://127.0.0.1:${server.port}/feed.xml`;

    const baseEnv = {
      WACHI_DB_PATH: dbPath,
      WACHI_NO_AUTO_UPDATE: "1",
    };

    const sub = await runCli(
      ["sub", "-n", "main", "-a", "slack://token/channel", feedUrl, "--config", configPath],
      baseEnv,
    );
    expect(sub.exitCode).toBe(0);
    expect(sub.stdout).toContain("Subscribed (RSS)");

    const dryRunNoNew = await runCli(["check", "--dry-run", "--config", configPath], baseEnv);
    expect(dryRunNoNew.exitCode).toBe(0);
    expect(dryRunNoNew.stdout).toContain("[dry-run] 0 items would be sent");

    feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test Feed</title>
<item><title>Item 1</title><link>https://example.com/1</link><guid>https://example.com/1</guid></item>
<item><title>Item 2</title><link>https://example.com/2</link><guid>https://example.com/2</guid></item>
</channel></rss>`;

    const dryRunNew = await runCli(["check", "--dry-run", "--config", configPath], baseEnv);
    expect(dryRunNew.exitCode).toBe(0);
    expect(dryRunNew.stdout).toContain("would send: Item 2");

    const unsub = await runCli(["unsub", "-n", "main", feedUrl, "--config", configPath], baseEnv);
    expect(unsub.exitCode).toBe(0);
    expect(unsub.stdout).toContain("Removed:");
  });

  it("supports send-existing flag in JSON output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-send-existing-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");

    const feedXml = createFeed("Item 1", "https://example.com/1");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(feedXml, {
          headers: { "content-type": "application/rss+xml" },
        });
      },
    });
    servers.push(server);
    const feedUrl = `http://127.0.0.1:${server.port}/feed.xml`;

    const result = await runCli(
      [
        "sub",
        "--json",
        "--send-existing",
        "-n",
        "main",
        "-a",
        "slack://token/channel",
        feedUrl,
        "--config",
        configPath,
      ],
      { WACHI_DB_PATH: dbPath, WACHI_NO_AUTO_UPDATE: "1" },
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data.baseline_count).toBe(0);
  });
});
