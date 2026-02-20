import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectedDb, connectDb } from "../../src/lib/db/connect.ts";
import { getMetaValue } from "../../src/lib/db/get-meta-value.ts";
import { fetchRssSubscriptionItems } from "../../src/lib/subscriptions/fetch-rss-subscription-items.ts";
import { WachiError } from "../../src/utils/error.ts";

let tempDir = "";
let connection: ConnectedDb | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-int-rss-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
});

afterEach(async () => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }
  connection?.sqlite.close();
  connection = null;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Feed</title>
    <item>
      <title>One</title>
      <link>/one</link>
      <guid>/one</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const feedWithoutTitleXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>One</title>
      <link>/one</link>
      <guid>/one</guid>
    </item>
  </channel>
</rss>`;

describe("fetchRssSubscriptionItems integration", () => {
  it("stores ETag and returns notModified on conditional 304", async () => {
    const etag = '"abc-123"';
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/site") {
          return new Response(
            "<html><head><title>Example Site</title><link rel='icon' href='/icons/site.png'></head></html>",
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname !== "/feed.xml") {
          return new Response("not found", { status: 404 });
        }

        const ifNoneMatch = request.headers.get("if-none-match");
        if (ifNoneMatch === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }

        return new Response(feedXml, {
          status: 200,
          headers: {
            "content-type": "application/rss+xml",
            etag,
          },
        });
      },
    });
    servers.push(server);

    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const rssUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    const subscriptionUrl = `http://127.0.0.1:${server.port}/site`;
    const first = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
    });

    expect(first.notModified).toBe(false);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.link).toBe(`http://127.0.0.1:${server.port}/one`);
    expect(first.sourceIdentity?.username).toBe("Feed");
    expect(first.sourceIdentity?.avatarUrl).toBe(`http://127.0.0.1:${server.port}/icons/site.png`);
    expect(getMetaValue(db, `etag:${rssUrl}`)).toBe(etag);

    const second = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
    });

    expect(second.notModified).toBe(true);
    expect(second.items).toEqual([]);
  });

  it("stores Last-Modified and sends If-Modified-Since", async () => {
    const lastModified = "Mon, 01 Jan 2024 00:00:00 GMT";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/site") {
          return new Response(
            "<html><head><title>Example Site</title><link rel='icon' href='/icons/site.png'></head></html>",
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname !== "/feed.xml") {
          return new Response("not found", { status: 404 });
        }

        const ifModifiedSince = request.headers.get("if-modified-since");
        if (ifModifiedSince === lastModified) {
          return new Response(null, { status: 304, headers: { "last-modified": lastModified } });
        }

        return new Response(feedXml, {
          status: 200,
          headers: {
            "content-type": "application/rss+xml",
            "last-modified": lastModified,
          },
        });
      },
    });
    servers.push(server);

    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const rssUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    const subscriptionUrl = `http://127.0.0.1:${server.port}/site`;
    await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
    });

    expect(getMetaValue(db, `last-modified:${rssUrl}`)).toBe(lastModified);

    const second = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
    });

    expect(second.notModified).toBe(true);
  });

  it("throws WachiError when RSS endpoint returns >= 400", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("blocked", { status: 503, statusText: "Service Unavailable" });
      },
    });
    servers.push(server);

    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const rssUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    await expect(
      fetchRssSubscriptionItems({
        subscriptionUrl: "https://example.com",
        rssUrl,
        db,
        useConditionalRequest: true,
      }),
    ).rejects.toBeInstanceOf(WachiError);
  });

  it("falls back to website title and favicon when RSS metadata is missing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/site") {
          return new Response(
            "<html><head><title>Website Title</title><link rel='icon' href='/icons/site.png'></head></html>",
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname === "/feed.xml") {
          return new Response(feedWithoutTitleXml, {
            headers: { "content-type": "application/rss+xml" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const rssUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    const subscriptionUrl = `http://127.0.0.1:${server.port}/site`;
    const result = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
    });

    expect(result.notModified).toBe(false);
    expect(result.sourceIdentity?.username).toBe("Website Title");
    expect(result.sourceIdentity?.avatarUrl).toBe(`http://127.0.0.1:${server.port}/icons/site.png`);
  });
});
