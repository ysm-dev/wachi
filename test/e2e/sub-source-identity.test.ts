import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }
  for (const dir of testDirs.splice(0, testDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("wachi sub source identity", () => {
  it("personalizes the initial subscribe notification with source branding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-sub-identity-"));
    testDirs.push(dir);

    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");
    const binDir = join(dir, "bin");
    const uvxArgsPath = join(dir, "uvx-args.txt");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "uvx"),
      `#!/bin/sh
last=""
for arg in "$@"; do
  last="$arg"
done
printf '%s' "$last" > "$WACHI_TEST_UVX_ARGS"
`,
      { mode: 0o755 },
    );

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/feed.xml") {
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>${url.origin}/site</link>
    <item>
      <title>Item 1</title>
      <link>${url.origin}/items/1</link>
      <guid>${url.origin}/items/1</guid>
    </item>
  </channel>
</rss>`,
            { headers: { "content-type": "application/rss+xml" } },
          );
        }

        if (url.pathname === "/site") {
          return new Response(
            "<html><head><title>Example Site</title><link rel='icon' href='/icons/site.png'></head></html>",
            { headers: { "content-type": "text/html" } },
          );
        }

        if (url.pathname === "/icons/site.png") {
          return new Response("icon", {
            headers: { "content-type": "image/png" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const feedUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    const result = await runCli(
      ["sub", "-n", "main", "-a", "discord://12345/token", feedUrl, "--config", configPath],
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        WACHI_DB_PATH: dbPath,
        WACHI_NO_AUTO_UPDATE: "1",
        WACHI_TEST_UVX_ARGS: uvxArgsPath,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sent: Item 1");
    expect(result.stderr).not.toContain("Warning: failed to send latest item notification");

    const personalizedUrl = decodeURIComponent(await readFile(uvxArgsPath, "utf8"));

    expect(personalizedUrl).toContain("discord://Example Feed@12345/token");
    expect(personalizedUrl).toContain(`avatar_url=http://127.0.0.1:${server.port}/icons/site.png`);
  });
});
