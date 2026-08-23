import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const createFakeAppriseBin = async (dir: string): Promise<string> => {
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, "uvx"),
    '#!/bin/sh\nfor last do :; done\n[ -n "$WACHI_TEST_CAPTURE" ] && printf "%s" "$last" > "$WACHI_TEST_CAPTURE"\nexit 0\n',
    { mode: 0o755 },
  );
  return binDir;
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
    const binDir = await createFakeAppriseBin(dir);

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
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      WACHI_DB_PATH: dbPath,
      WACHI_NO_ARCHIVE: "1",
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

  it("prints same-feed items oldest-first in dry-run without pubDate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-feed-order-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Ordered Feed</title>
<item><title>Newest</title><link>https://example.com/newest</link><guid>https://example.com/newest</guid></item>
<item><title>Older</title><link>https://example.com/older</link><guid>https://example.com/older</guid></item>
<item><title>Oldest</title><link>https://example.com/oldest</link><guid>https://example.com/oldest</guid></item>
</channel></rss>`;

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
      WACHI_NO_ARCHIVE: "1",
      WACHI_NO_AUTO_UPDATE: "1",
    };

    const sub = await runCli(
      [
        "sub",
        "--send-existing",
        "-n",
        "main",
        "-a",
        "slack://token/channel",
        feedUrl,
        "--config",
        configPath,
      ],
      baseEnv,
    );
    expect(sub.exitCode).toBe(0);

    const dryRun = await runCli(["check", "--dry-run", "--config", configPath], baseEnv);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout.split("\n")).toEqual([
      "[dry-run] would send: Oldest -> main",
      "[dry-run] would send: Older -> main",
      "[dry-run] would send: Newest -> main",
      "[dry-run] 3 items would be sent",
    ]);
  });

  it("stores RSS origin URL from feed link and supports feed-url dedupe/remove", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-rss-origin-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");
    const dbPath = join(dir, "wachi.db");
    const binDir = await createFakeAppriseBin(dir);

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/feed.xml") {
          const originUrl = `${url.origin}/site/`;
          const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test Feed</title><link>${originUrl}</link>
<item><title>Item 1</title><link>/1</link><guid>/1</guid></item>
</channel></rss>`;
          return new Response(xml, {
            headers: { "content-type": "application/rss+xml" },
          });
        }
        if (url.pathname === "/site" || url.pathname === "/site/") {
          return new Response("ok");
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const feedUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    const originUrl = `http://127.0.0.1:${server.port}/site/`;
    const baseEnv = {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      WACHI_DB_PATH: dbPath,
      WACHI_NO_ARCHIVE: "1",
      WACHI_NO_AUTO_UPDATE: "1",
    };

    const firstSub = await runCli(
      ["sub", "-n", "main", "-a", "slack://token/channel", feedUrl, "--config", configPath],
      baseEnv,
    );
    expect(firstSub.exitCode).toBe(0);
    expect(firstSub.stdout).toContain(`Subscribed (RSS): ${originUrl}`);
    expect(firstSub.stdout).toContain(`Feed: ${feedUrl}`);

    const listedText = await runCli(["ls", "--config", configPath], baseEnv);
    expect(listedText.exitCode).toBe(0);
    expect(listedText.stdout).toContain("main (slack://token.../channel)");
    expect(listedText.stdout).toContain(`Website: ${originUrl}`);
    expect(listedText.stdout).toContain(`RSS: ${feedUrl}`);

    const listed = await runCli(["ls", "--json", "--config", configPath], baseEnv);
    expect(listed.exitCode).toBe(0);
    const listedPayload = JSON.parse(listed.stdout);
    const subscription = listedPayload.data.channels[0]?.subscriptions[0];
    expect(subscription?.url).toBe(originUrl);
    expect(subscription?.rss_url).toBe(feedUrl);

    const secondSub = await runCli(
      ["sub", "--json", "-n", "main", feedUrl, "--config", configPath],
      baseEnv,
    );
    expect(secondSub.exitCode).toBe(0);
    const secondPayload = JSON.parse(secondSub.stdout);
    expect(secondPayload.ok).toBe(true);
    expect(secondPayload.data.url).toBe(originUrl);
    expect(secondPayload.data.rss_url).toBe(feedUrl);
    expect(secondPayload.data.baseline_count).toBe(0);

    const unsub = await runCli(["unsub", "-n", "main", feedUrl, "--config", configPath], baseEnv);
    expect(unsub.exitCode).toBe(0);
    expect(unsub.stdout).toContain("Removed:");

    const listedAfterUnsub = await runCli(["ls", "--json", "--config", configPath], baseEnv);
    expect(listedAfterUnsub.exitCode).toBe(0);
    const listedAfterUnsubPayload = JSON.parse(listedAfterUnsub.stdout);
    expect(listedAfterUnsubPayload.data.channels).toEqual([]);
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

  it("applies WACHI_APPRISE_URL to test notifications", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-test-override-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");
    const capturePath = join(dir, "apprise-url.txt");
    const binDir = await createFakeAppriseBin(dir);
    await writeFile(
      configPath,
      "channels:\n  - name: main\n    apprise_url: slack://saved/channel\n    subscriptions: []\n",
      "utf8",
    );

    const result = await runCli(["test", "--name", "main", "--config", configPath], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      WACHI_APPRISE_URL: "discord://override/token",
      WACHI_TEST_CAPTURE: capturePath,
      WACHI_NO_AUTO_UPDATE: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(capturePath).text()).toBe("discord://override/token");
    expect(result.stdout).toContain("discord://overr.../token");
  });

  it("preserves concurrent subscriptions to the same config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-concurrent-sub-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        return new Response(createFeed(path, `https://example.com${path}`), {
          headers: { "content-type": "application/rss+xml" },
        });
      },
    });
    servers.push(server);
    const firstUrl = `http://127.0.0.1:${server.port}/first.xml`;
    const secondUrl = `http://127.0.0.1:${server.port}/second.xml`;
    const commonArgs = ["sub", "--send-existing", "--name", "main", "--apprise-url", "slack://x/y"];

    const [first, second] = await Promise.all([
      runCli([...commonArgs, firstUrl, "--config", configPath], {
        WACHI_DB_PATH: join(dir, "first.db"),
        WACHI_NO_AUTO_UPDATE: "1",
      }),
      runCli([...commonArgs, secondUrl, "--config", configPath], {
        WACHI_DB_PATH: join(dir, "second.db"),
        WACHI_NO_AUTO_UPDATE: "1",
      }),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const listed = await runCli(["ls", "--json", "--config", configPath], {
      WACHI_NO_AUTO_UPDATE: "1",
    });
    const payload = JSON.parse(listed.stdout);
    expect(payload.data.channels[0].subscriptions).toHaveLength(2);
  });

  it("does not restore stale config when sub and unsub overlap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-e2e-sub-unsub-race-"));
    testDirs.push(dir);
    const configPath = join(dir, "config.yml");
    const oldUrl = "https://example.com/old.xml";
    await writeFile(
      configPath,
      `channels:
  - name: main
    apprise_url: slack://x/y
    subscriptions:
      - url: ${oldUrl}
        rss_url: ${oldUrl}
`,
      "utf8",
    );

    let releaseFeed!: () => void;
    let markFeedRequested!: () => void;
    const feedGate = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    const feedRequested = new Promise<void>((resolve) => {
      markFeedRequested = resolve;
    });
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        markFeedRequested();
        await feedGate;
        const url = request.url;
        return new Response(createFeed("new", url), {
          headers: { "content-type": "application/rss+xml" },
        });
      },
    });
    servers.push(server);
    const newUrl = `http://127.0.0.1:${server.port}/new.xml`;
    const baseEnv = { WACHI_NO_AUTO_UPDATE: "1" };

    const subscribe = runCli(
      [
        "sub",
        "--send-existing",
        "--name",
        "main",
        "--apprise-url",
        "slack://x/y",
        newUrl,
        "--config",
        configPath,
      ],
      { ...baseEnv, WACHI_DB_PATH: join(dir, "sub.db") },
    );
    await feedRequested;

    const unsubscribe = await runCli(
      ["unsub", "--name", "main", oldUrl, "--config", configPath],
      baseEnv,
    );
    expect(unsubscribe.exitCode).toBe(0);
    releaseFeed();
    expect((await subscribe).exitCode).toBe(0);

    const listed = await runCli(["ls", "--json", "--config", configPath], baseEnv);
    const subscriptions = JSON.parse(listed.stdout).data.channels[0].subscriptions;
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].rss_url).toBe(newUrl);
  });
});
