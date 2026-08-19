import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runCli = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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

/**
 * Serves `/ok-N.xml` as a valid feed and everything else as HTTP 500.
 */
const startServer = () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/ok-")) {
        return new Response(
          createFeed(`Item ${url.pathname}`, `https://example.com${url.pathname}`),
          {
            headers: { "content-type": "application/rss+xml" },
          },
        );
      }
      return new Response("blocked", { status: 500 });
    },
  });
  servers.push(server);
  return { port: server.port ?? 0 };
};

/**
 * Spreads `paths` across two channels, mirroring a real multi-channel setup.
 */
const writeConfig = async (path: string, port: number, paths: string[]): Promise<void> => {
  const toEntry = (pathname: string) => {
    const url = `http://127.0.0.1:${port}${pathname}`;
    return `      - url: "${url}"\n        rss_url: "${url}"`;
  };

  const half = Math.ceil(paths.length / 2);
  const text = `channels:
  - name: "alpha"
    apprise_url: "slack://token/alpha"
    subscriptions:
${paths.slice(0, half).map(toEntry).join("\n")}
  - name: "beta"
    apprise_url: "slack://token/beta"
    subscriptions:
${paths.slice(half).map(toEntry).join("\n")}
`;
  await writeFile(path, text, "utf8");
};

const setup = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return {
    configPath: join(dir, "config.yml"),
    env: { WACHI_DB_PATH: join(dir, "wachi.db"), WACHI_NO_AUTO_UPDATE: "1" },
  };
};

describe("wachi check run-level outage suppression", () => {
  it("suppresses failure counters when most subscriptions fail in one run", async () => {
    const server = startServer();
    const { configPath, env } = await setup("wachi-e2e-outage-");
    const paths = ["/f1.xml", "/f2.xml", "/f3.xml", "/f4.xml", "/f5.xml", "/f6.xml"];
    await writeConfig(configPath, server.port, paths);

    // Repeat well past the 10-failure alert milestone.
    for (let run = 0; run < 12; run++) {
      const result = await runCli(["check", "--json", "--dry-run", "--config", configPath], env);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.outage_suspected).toBe(true);
      // Errors stay truthful so cron still sees a non-zero exit.
      expect(payload.data.errors.length).toBe(6);
      expect(result.exitCode).toBe(1);
    }

    const listed = await runCli(["ls", "--config", configPath], env);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).not.toContain("failures");
  }, 60_000);

  it("records failures normally when only a minority fail", async () => {
    const server = startServer();
    const { configPath, env } = await setup("wachi-e2e-minority-");
    const paths = ["/ok-1.xml", "/ok-2.xml", "/ok-3.xml", "/ok-4.xml", "/f1.xml", "/f2.xml"];
    await writeConfig(configPath, server.port, paths);

    const result = await runCli(["check", "--json", "--dry-run", "--config", configPath], env);
    const payload = JSON.parse(result.stdout);

    expect(payload.data.outage_suspected).toBe(false);
    expect(payload.data.errors.length).toBe(2);
    expect(result.exitCode).toBe(2);

    const listed = await runCli(["ls", "--config", configPath], env);
    expect(listed.stdout).toContain("[1 failures]");
  }, 30_000);

  it("does not suppress a small config where every subscription fails", async () => {
    const server = startServer();
    const { configPath, env } = await setup("wachi-e2e-small-");
    await writeConfig(configPath, server.port, ["/f1.xml", "/f2.xml"]);

    const result = await runCli(["check", "--json", "--dry-run", "--config", configPath], env);
    const payload = JSON.parse(result.stdout);

    expect(payload.data.outage_suspected).toBe(false);
    expect(result.exitCode).toBe(1);

    const listed = await runCli(["ls", "--config", configPath], env);
    expect(listed.stdout).toContain("[1 failures]");
  }, 30_000);
});
