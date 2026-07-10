import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FeedItem = {
  title: string;
  link: string;
};

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

const createFeed = (items: FeedItem[]): string => {
  const entries = items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link><guid>${item.link}</guid></item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test Feed</title>
${entries}
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

const createHarness = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  testDirs.push(dir);
  const binDir = join(dir, "bin");
  const appriseLogPath = join(dir, "apprise.log");
  const appriseCountPath = join(dir, "apprise.count");
  await mkdir(binDir, { recursive: true });
  await writeFile(appriseLogPath, "", "utf8");
  await writeFile(appriseCountPath, "0", "utf8");
  await writeFile(
    join(binDir, "uvx"),
    `#!/bin/sh
if [ "$1" != "apprise" ]; then
  exit 0
fi
printf '%s\\036' "$3" >> "$WACHI_TEST_APPRISE_LOG"
count=0
if [ -f "$WACHI_TEST_APPRISE_COUNT" ]; then
  IFS= read -r count < "$WACHI_TEST_APPRISE_COUNT"
fi
count=$((count + 1))
printf '%s' "$count" > "$WACHI_TEST_APPRISE_COUNT"
if [ -n "$WACHI_TEST_APPRISE_FAIL_AT" ] && [ "$count" -eq "$WACHI_TEST_APPRISE_FAIL_AT" ]; then
  printf '%s' 'delivery failed' >&2
  exit 1
fi
`,
    { mode: 0o755 },
  );

  return {
    configPath: join(dir, "config.yml"),
    dbPath: join(dir, "wachi.db"),
    appriseLogPath,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      WACHI_DB_PATH: join(dir, "wachi.db"),
      WACHI_NO_ARCHIVE: "1",
      WACHI_NO_AUTO_UPDATE: "1",
      WACHI_TEST_APPRISE_COUNT: appriseCountPath,
      WACHI_TEST_APPRISE_LOG: appriseLogPath,
    },
  };
};

const readNotificationBodies = async (path: string): Promise<string[]> => {
  const contents = await readFile(path, "utf8");
  return contents.split("\x1e").filter(Boolean);
};

describe("delivery ledger cutover", () => {
  it("baselines older items and sends a new latest link once per destination", async () => {
    const harness = await createHarness("wachi-e2e-delivery-latest-");
    const sharedLatest = "https://example.com/shared-latest";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/first.xml") {
          return new Response(
            createFeed([
              { title: "Shared Latest", link: sharedLatest },
              { title: "First Older", link: "https://example.com/first-older" },
            ]),
            { headers: { "content-type": "application/rss+xml" } },
          );
        }
        if (pathname === "/second.xml") {
          return new Response(
            createFeed([
              { title: "Shared Latest Again", link: sharedLatest },
              { title: "Second Older", link: "https://example.com/second-older" },
            ]),
            { headers: { "content-type": "application/rss+xml" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const firstUrl = `http://127.0.0.1:${server.port}/first.xml`;
    const secondUrl = `http://127.0.0.1:${server.port}/second.xml`;
    const destination = "slack://token/shared-channel";
    const first = await runCli(
      ["sub", "--json", "-n", "first", "-a", destination, firstUrl, "--config", harness.configPath],
      harness.env,
    );
    const second = await runCli(
      [
        "sub",
        "--json",
        "-n",
        "second",
        "-a",
        destination,
        secondUrl,
        "--config",
        harness.configPath,
      ],
      harness.env,
    );

    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).data.baseline_count).toBe(2);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).data.baseline_count).toBe(1);
    const notifications = await readNotificationBodies(harness.appriseLogPath);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(sharedLatest);
    expect(notifications[0]).toContain("Shared Latest");
    expect(notifications[0]).not.toContain("First Older");
    expect(notifications[0]).not.toContain("Second Older");
  });

  it("defers all current items with --send-existing until the next check", async () => {
    const harness = await createHarness("wachi-e2e-send-existing-cutover-");
    const feedXml = createFeed([
      { title: "Newest", link: "https://example.com/newest" },
      { title: "Older", link: "https://example.com/older" },
      { title: "Oldest", link: "https://example.com/oldest" },
    ]);
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

    const sub = await runCli(
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
        harness.configPath,
      ],
      harness.env,
    );

    expect(sub.exitCode).toBe(0);
    expect(JSON.parse(sub.stdout).data.baseline_count).toBe(0);
    expect(await readNotificationBodies(harness.appriseLogPath)).toEqual([]);

    const firstCheck = await runCli(
      ["check", "--json", "--config", harness.configPath],
      harness.env,
    );
    expect(firstCheck.exitCode).toBe(0);
    expect(JSON.parse(firstCheck.stdout).data.sent).toHaveLength(3);
    const notifications = await readNotificationBodies(harness.appriseLogPath);
    expect(notifications).toHaveLength(3);
    expect(notifications.join("\n")).toContain("Newest");
    expect(notifications.join("\n")).toContain("Older");
    expect(notifications.join("\n")).toContain("Oldest");

    const secondCheck = await runCli(
      ["check", "--json", "--config", harness.configPath],
      harness.env,
    );
    expect(secondCheck.exitCode).toBe(0);
    expect(JSON.parse(secondCheck.stdout).data.sent).toEqual([]);
    expect(await readNotificationBodies(harness.appriseLogPath)).toHaveLength(3);
  });

  it("baselines a preconfigured database once before sending later items", async () => {
    const harness = await createHarness("wachi-e2e-existing-cutover-");
    let feedXml = createFeed([
      { title: "Current", link: "https://example.com/current" },
      { title: "Older", link: "https://example.com/older" },
    ]);
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
    await writeFile(
      harness.configPath,
      `channels:
  - name: "main"
    apprise_url: "slack://token/channel"
    subscriptions:
      - url: "${feedUrl}"
        rss_url: "${feedUrl}"
`,
      "utf8",
    );

    const preview = await runCli(
      ["check", "--json", "--dry-run", "--config", harness.configPath],
      harness.env,
    );
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout).data.sent).toHaveLength(2);

    const cutover = await runCli(["check", "--json", "--config", harness.configPath], harness.env);
    expect(cutover.exitCode).toBe(0);
    expect(JSON.parse(cutover.stdout).data).toMatchObject({ sent: [], skipped: 2, errors: [] });
    expect(await readNotificationBodies(harness.appriseLogPath)).toEqual([]);

    feedXml = createFeed([
      { title: "After Cutover", link: "https://example.com/after-cutover" },
      { title: "Current", link: "https://example.com/current" },
      { title: "Older", link: "https://example.com/older" },
    ]);
    const nextCheck = await runCli(
      ["check", "--json", "--config", harness.configPath],
      harness.env,
    );

    expect(nextCheck.exitCode).toBe(0);
    expect(JSON.parse(nextCheck.stdout).data.sent).toEqual([
      {
        title: "After Cutover",
        link: "https://example.com/after-cutover",
        channel_name: "main",
      },
    ]);
    const notifications = await readNotificationBodies(harness.appriseLogPath);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("After Cutover");
  });

  it("does not add or send an alias resolving to an already prepared RSS URL", async () => {
    const harness = await createHarness("wachi-e2e-rss-alias-");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/first" || url.pathname === "/second") {
          return new Response(
            `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname === "/feed.xml") {
          return new Response(
            createFeed([
              { title: "Alias Latest", link: "https://example.com/alias-latest" },
              { title: "Alias Older", link: "https://example.com/alias-older" },
            ]),
            { headers: { "content-type": "application/rss+xml" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const firstAlias = `http://127.0.0.1:${server.port}/first`;
    const secondAlias = `http://127.0.0.1:${server.port}/second`;

    const first = await runCli(
      [
        "sub",
        "--json",
        "-n",
        "main",
        "-a",
        "slack://token/channel",
        firstAlias,
        "--config",
        harness.configPath,
      ],
      harness.env,
    );
    const second = await runCli(
      ["sub", "--json", "-n", "main", secondAlias, "--config", harness.configPath],
      harness.env,
    );

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).data.baseline_count).toBe(0);
    const listed = await runCli(["ls", "--json", "--config", harness.configPath], harness.env);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).data.channels[0].subscriptions).toHaveLength(1);
    const notifications = await readNotificationBodies(harness.appriseLogPath);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("Alias Latest");
  });

  it("returns 1 when the only delivery fails, then retries it on the next check", async () => {
    const harness = await createHarness("wachi-e2e-outbox-exit1-");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          createFeed([{ title: "Only Item", link: "https://example.com/only" }]),
          { headers: { "content-type": "application/rss+xml" } },
        );
      },
    });
    servers.push(server);
    const feedUrl = `http://127.0.0.1:${server.port}/feed.xml`;
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
        harness.configPath,
      ],
      harness.env,
    );
    expect(sub.exitCode).toBe(0);

    const failed = await runCli(["check", "--json", "--config", harness.configPath], {
      ...harness.env,
      WACHI_TEST_APPRISE_FAIL_AT: "1",
    });

    expect(failed.exitCode).toBe(1);
    const failedPayload = JSON.parse(failed.stdout);
    expect(failedPayload.ok).toBe(true);
    expect(failedPayload.data.sent).toEqual([]);
    expect(failedPayload.data.errors).toHaveLength(1);
    expect(await readNotificationBodies(harness.appriseLogPath)).toHaveLength(1);

    // A non-zero apprise exit means the message was definitively not delivered,
    // so the durable item must be retried on the next check.
    const retry = await runCli(["check", "--json", "--config", harness.configPath], harness.env);
    expect(retry.exitCode).toBe(0);
    const retryPayload = JSON.parse(retry.stdout);
    expect(retryPayload.data.sent).toHaveLength(1);
    expect(retryPayload.data.sent[0].link).toBe("https://example.com/only");
    expect(await readNotificationBodies(harness.appriseLogPath)).toHaveLength(2);
  });

  it("returns 2 on partial delivery and retries only the failed item next check", async () => {
    const harness = await createHarness("wachi-e2e-outbox-exit2-");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          createFeed([
            { title: "Second", link: "https://example.com/second" },
            { title: "First", link: "https://example.com/first" },
          ]),
          { headers: { "content-type": "application/rss+xml" } },
        );
      },
    });
    servers.push(server);
    const feedUrl = `http://127.0.0.1:${server.port}/feed.xml`;
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
        harness.configPath,
      ],
      harness.env,
    );
    expect(sub.exitCode).toBe(0);

    // Items are delivered oldest-first: "First" (attempt 1) succeeds, "Second"
    // (attempt 2) fails.
    const partial = await runCli(["check", "--json", "--config", harness.configPath], {
      ...harness.env,
      WACHI_TEST_APPRISE_FAIL_AT: "2",
    });
    expect(partial.exitCode).toBe(2);
    const partialPayload = JSON.parse(partial.stdout);
    expect(partialPayload.data.sent).toHaveLength(1);
    expect(partialPayload.data.sent[0].link).toBe("https://example.com/first");
    expect(partialPayload.data.errors).toHaveLength(1);
    expect(await readNotificationBodies(harness.appriseLogPath)).toHaveLength(2);

    // Only the failed item is retried; the delivered one is not resent.
    const nextCheck = await runCli(
      ["check", "--json", "--config", harness.configPath],
      harness.env,
    );
    expect(nextCheck.exitCode).toBe(0);
    const nextPayload = JSON.parse(nextCheck.stdout);
    expect(nextPayload.data.sent).toHaveLength(1);
    expect(nextPayload.data.sent[0].link).toBe("https://example.com/second");
    expect(await readNotificationBodies(harness.appriseLogPath)).toHaveLength(3);

    const finalCheck = await runCli(
      ["check", "--json", "--config", harness.configPath],
      harness.env,
    );
    expect(finalCheck.exitCode).toBe(0);
    expect(JSON.parse(finalCheck.stdout).data.sent).toEqual([]);
    expect(await readNotificationBodies(harness.appriseLogPath)).toHaveLength(3);
  });
});
