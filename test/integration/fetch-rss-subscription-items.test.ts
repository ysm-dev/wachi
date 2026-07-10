import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectedDb, connectDb } from "../../src/lib/db/connect.ts";
import { getMetaValue } from "../../src/lib/db/get-meta-value.ts";
import {
  fetchRssSubscriptionItems,
  persistRssValidators,
} from "../../src/lib/subscriptions/fetch-rss-subscription-items.ts";
import { googleS2FaviconUrl } from "../../src/lib/subscriptions/source-branding.ts";
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

const feedWithInvalidImageXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Feed With Bad Image</title>
    <image>
      <url>http://[invalid</url>
    </image>
    <item>
      <title>One</title>
      <link>/one</link>
      <guid>/one</guid>
    </item>
  </channel>
</rss>`;

describe("fetchRssSubscriptionItems integration", () => {
  it("returns ETag without storing it and uses it after explicit persistence", async () => {
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
    const validatorScope = "destination:1";
    const first = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
      validatorScope,
    });

    expect(first.notModified).toBe(false);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.link).toBe(`http://127.0.0.1:${server.port}/one`);
    expect(first.sourceIdentity?.username).toBe("Feed");
    expect(first.sourceIdentity?.avatarUrl).toBe(googleS2FaviconUrl(subscriptionUrl) ?? undefined);
    expect(first.validators).toEqual({ etag, lastModified: null });
    expect(getMetaValue(db, `etag:${validatorScope}:${rssUrl}`)).toBeNull();
    expect(getMetaValue(db, `etag:${rssUrl}`)).toBeNull();

    // Durable item handling completes before the caller commits the returned validators.
    persistRssValidators(db, rssUrl, first.validators, validatorScope);
    expect(getMetaValue(db, `etag:${validatorScope}:${rssUrl}`)).toBe(etag);

    const second = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
      validatorScope,
    });

    expect(second.notModified).toBe(true);
    expect(second.items).toEqual([]);
    expect(second.validators).toEqual({ etag, lastModified: null });
  });

  it("returns Last-Modified without storing it and sends it after explicit persistence", async () => {
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
    const validatorScope = "destination:2";
    const first = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
      validatorScope,
    });

    expect(first.validators).toEqual({ etag: null, lastModified });
    expect(getMetaValue(db, `last-modified:${validatorScope}:${rssUrl}`)).toBeNull();
    expect(getMetaValue(db, `last-modified:${rssUrl}`)).toBeNull();

    persistRssValidators(db, rssUrl, first.validators, validatorScope);
    expect(getMetaValue(db, `last-modified:${validatorScope}:${rssUrl}`)).toBe(lastModified);

    const second = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
      validatorScope,
    });

    expect(second.notModified).toBe(true);
  });

  it("keeps validator scopes independent", async () => {
    const scopeAEtag = '"scope-a"';
    const scopeBEtag = '"scope-b"';
    const conditionalHeaders: Array<string | null> = [];
    let fullResponses = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/feed.xml") {
          return new Response("not found", { status: 404 });
        }

        const ifNoneMatch = request.headers.get("if-none-match");
        conditionalHeaders.push(ifNoneMatch);
        if (ifNoneMatch === scopeAEtag || ifNoneMatch === scopeBEtag) {
          return new Response(null, { status: 304, headers: { etag: ifNoneMatch } });
        }

        const etag = fullResponses === 0 ? scopeAEtag : scopeBEtag;
        fullResponses += 1;
        return new Response(feedXml, {
          headers: { "content-type": "application/rss+xml", etag },
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
    const scopeA = "destination:10";
    const scopeB = "destination:20";

    const firstA = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
      validatorScope: scopeA,
    });
    persistRssValidators(db, rssUrl, firstA.validators, scopeA);

    const firstB = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
      validatorScope: scopeB,
    });
    persistRssValidators(db, rssUrl, firstB.validators, scopeB);

    const secondA = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
      validatorScope: scopeA,
    });
    const secondB = await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: true,
      validatorScope: scopeB,
    });

    expect(firstA.validators.etag).toBe(scopeAEtag);
    expect(firstB.validators.etag).toBe(scopeBEtag);
    expect(secondA.notModified).toBe(true);
    expect(secondB.notModified).toBe(true);
    expect(conditionalHeaders).toEqual([null, null, scopeAEtag, scopeBEtag]);
    expect(getMetaValue(db, `etag:${scopeA}:${rssUrl}`)).toBe(scopeAEtag);
    expect(getMetaValue(db, `etag:${scopeB}:${rssUrl}`)).toBe(scopeBEtag);
  });

  it("resolves relative item links against the RSS URL", async () => {
    const relativeLinkFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Relative Link Feed</title>
    <item>
      <title>One</title>
      <link>items/one</link>
    </item>
  </channel>
</rss>`;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/feeds/current.xml") {
          return new Response(relativeLinkFeedXml, {
            headers: { "content-type": "application/rss+xml" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const rssUrl = `http://127.0.0.1:${server.port}/feeds/current.xml`;
    const result = await fetchRssSubscriptionItems({
      subscriptionUrl: `http://127.0.0.1:${server.port}/site/articles/index.html`,
      rssUrl,
    });

    expect(result.items[0]?.link).toBe(`http://127.0.0.1:${server.port}/feeds/items/one`);
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
    expect(result.sourceIdentity?.avatarUrl).toBe(googleS2FaviconUrl(subscriptionUrl) ?? undefined);
  });

  it("reuses cached website branding across repeated checks", async () => {
    let siteRequests = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/site") {
          siteRequests += 1;
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

    await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: false,
    });

    await fetchRssSubscriptionItems({
      subscriptionUrl,
      rssUrl,
      db,
      useConditionalRequest: false,
    });

    expect(siteRequests).toBe(1);
  });

  it("falls back to the original link favicon when website fetch returns >= 400", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/site") {
          return new Response("blocked", { status: 500 });
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

    expect(result.sourceIdentity?.username).toBe("127.0.0.1");
    expect(result.sourceIdentity?.avatarUrl).toBe(googleS2FaviconUrl(subscriptionUrl) ?? undefined);
  });

  it("falls back safely when website branding fetch throws", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(feedWithoutTitleXml, {
          headers: { "content-type": "application/rss+xml" },
        });
      },
    });
    servers.push(server);

    const db = connection?.db;
    if (!db) {
      throw new Error("db not initialized");
    }

    const rssUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    const result = await fetchRssSubscriptionItems({
      subscriptionUrl: "not-a-url",
      rssUrl,
      db,
      useConditionalRequest: true,
    });

    expect(result.sourceIdentity?.username).toBeUndefined();
    expect(result.sourceIdentity?.avatarUrl).toBeUndefined();
  });

  it("uses the original link favicon when feed image URL is invalid", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/site") {
          return new Response(
            "<html><head><title>Original Site</title><link rel='icon' href='/icons/site.png'></head></html>",
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname === "/feed.xml") {
          return new Response(feedWithInvalidImageXml, {
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

    expect(result.sourceIdentity?.username).toBe("Feed With Bad Image");
    expect(result.sourceIdentity?.avatarUrl).toBe(googleS2FaviconUrl(subscriptionUrl) ?? undefined);
  });
});
