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

const createFeed = (slug: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${slug}</title>
<item><title>${slug}</title><link>https://example.com/${slug}</link><guid>https://example.com/${slug}</guid></item>
</channel></rss>`;

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
 * A feed backend. `alive: false` models the process being down: every request
 * fails, exactly like a stopped container.
 */
const startBackend = (alive: boolean) => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (!alive) {
        return new Response("service unavailable", { status: 503 });
      }
      const slug = new URL(request.url).pathname.slice(1);
      return slug.startsWith("dead")
        ? new Response("gone", { status: 404 })
        : new Response(createFeed(slug), {
            headers: { "content-type": "application/rss+xml" },
          });
    },
  });
  servers.push(server);
  return server.port ?? 0;
};

type Sub = { host: number; slug: string };

/**
 * Spreads subscriptions across three channels, as in a real multi-channel setup.
 */
const writeConfig = async (path: string, subs: Sub[]): Promise<void> => {
  const channels = ["tech", "news", "design"];
  const grouped = channels.map((name, index) => ({
    name,
    subs: subs.filter((_, i) => i % channels.length === index),
  }));

  const text = `channels:\n${grouped
    .map(
      ({ name, subs: channelSubs }) =>
        `  - name: "${name}"\n    apprise_url: "slack://token/${name}"\n    subscriptions:\n${channelSubs
          .map(({ host, slug }) => {
            const url = `http://127.0.0.1:${host}/${slug}`;
            return `      - url: "${url}"\n        rss_url: "${url}"`;
          })
          .join("\n")}`,
    )
    .join("\n")}\n`;

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

describe("wachi check host outage detection", () => {
  it("suppresses a dead self-hosted backend that is a minority of the run", async () => {
    // Mirrors the real setup: torss down, RSSHub and the public web fine.
    const torss = startBackend(false);
    const rsshub = startBackend(true);
    const web = startBackend(true);

    const subs: Sub[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ host: torss, slug: `torss-${i}` })),
      ...Array.from({ length: 7 }, (_, i) => ({ host: rsshub, slug: `rsshub-${i}` })),
      ...Array.from({ length: 8 }, (_, i) => ({ host: web, slug: `web-${i}` })),
    ];

    const { configPath, env } = await setup("wachi-e2e-hostout-");
    await writeConfig(configPath, subs);

    // 6 of 21 subscriptions fail: 29%, nowhere near the run-level 50% threshold.
    for (let run = 0; run < 12; run++) {
      const result = await runCli(["check", "--json", "--dry-run", "--config", configPath], env);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.outage_suspected).toBe(false);
      expect(payload.data.outaged_hosts).toEqual([`127.0.0.1:${torss}`]);
      expect(payload.data.errors.length).toBe(6);
    }

    const listed = await runCli(["ls", "--config", configPath], env);
    expect(listed.stdout).not.toContain("failures");
  }, 90_000);

  it("still records a single dead feed on an otherwise healthy host", async () => {
    const web = startBackend(true);
    const subs: Sub[] = [
      { host: web, slug: "dead-one" },
      ...Array.from({ length: 5 }, (_, i) => ({ host: web, slug: `web-${i}` })),
    ];

    const { configPath, env } = await setup("wachi-e2e-hostok-");
    await writeConfig(configPath, subs);

    const result = await runCli(["check", "--json", "--dry-run", "--config", configPath], env);
    const payload = JSON.parse(result.stdout);

    expect(payload.data.outaged_hosts).toEqual([]);
    expect(payload.data.errors.length).toBe(1);

    const listed = await runCli(["ls", "--config", configPath], env);
    expect(listed.stdout).toContain("[1 failures]");
  }, 30_000);
});
