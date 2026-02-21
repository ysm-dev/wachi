import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const createFeed = (title: string, link: string): string => {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test Feed</title>
<item><title>${title}</title><link>${link}</link><guid>${link}</guid></item>
</channel></rss>`;
};

const dirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }
  for (const dir of dirs.splice(0, dirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const writeConfig = async (path: string, okUrl: string, failUrl?: string): Promise<void> => {
  const failSub = failUrl ? `\n      - url: "${failUrl}"\n        rss_url: "${failUrl}"` : "";
  const text = `channels:
  - name: "main"
    apprise_url: "slack://token/channel"
    subscriptions:
      - url: "${okUrl}"
        rss_url: "${okUrl}"${failSub}
`;
  await writeFile(path, text, "utf8");
};

describe("wachi check exit code matrix", () => {
  it("returns 1 when all subscriptions fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-exit1-"));
    dirs.push(dir);
    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("blocked", { status: 500 });
      },
    });
    servers.push(server);
    const failUrl = `http://127.0.0.1:${server.port}/fail.xml`;
    await writeConfig(configPath, failUrl);

    const result = await runCli(["check", "--json", "--dry-run", "--config", configPath], {
      WACHI_DB_PATH: dbPath,
      WACHI_NO_AUTO_UPDATE: "1",
    });

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data.errors.length).toBe(1);
    expect(payload.data.sent.length).toBe(0);
  });

  it("returns 2 on partial success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-exit2-"));
    dirs.push(dir);
    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/ok.xml") {
          return new Response(createFeed("Item 1", "https://example.com/1"), {
            headers: { "content-type": "application/rss+xml" },
          });
        }
        return new Response("blocked", { status: 500 });
      },
    });
    servers.push(server);
    const okUrl = `http://127.0.0.1:${server.port}/ok.xml`;
    const failUrl = `http://127.0.0.1:${server.port}/fail.xml`;
    await writeConfig(configPath, okUrl, failUrl);

    const result = await runCli(["check", "--json", "--dry-run", "--config", configPath], {
      WACHI_DB_PATH: dbPath,
      WACHI_NO_AUTO_UPDATE: "1",
    });

    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data.errors.length).toBe(1);
    expect(payload.data.sent.length).toBe(1);
  });

  it("returns 0 when channel filter excludes failing channels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-exit0-channel-"));
    dirs.push(dir);
    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/ok.xml") {
          return new Response(createFeed("Item 1", "https://example.com/1"), {
            headers: { "content-type": "application/rss+xml" },
          });
        }
        return new Response("blocked", { status: 500 });
      },
    });
    servers.push(server);
    const okUrl = `http://127.0.0.1:${server.port}/ok.xml`;
    const failUrl = `http://127.0.0.1:${server.port}/fail.xml`;

    await writeFile(
      configPath,
      `channels:
  - name: "good"
    apprise_url: "slack://token/good"
    subscriptions:
      - url: "${okUrl}"
        rss_url: "${okUrl}"
  - name: "bad"
    apprise_url: "slack://token/bad"
    subscriptions:
      - url: "${failUrl}"
        rss_url: "${failUrl}"
`,
      "utf8",
    );

    const result = await runCli(
      ["check", "--json", "--dry-run", "--name", "good", "--config", configPath],
      {
        WACHI_DB_PATH: dbPath,
        WACHI_NO_AUTO_UPDATE: "1",
      },
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data.errors).toEqual([]);
    expect(payload.data.sent.length).toBe(1);
  });
});
