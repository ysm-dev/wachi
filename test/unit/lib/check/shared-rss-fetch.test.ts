import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSharedRssFetcher,
  resolveSharedRssValidators,
} from "../../../../src/lib/check/shared-rss-fetch.ts";
import { type ConnectedDb, connectDb } from "../../../../src/lib/db/connect.ts";
import { persistRssValidators } from "../../../../src/lib/subscriptions/fetch-rss-subscription-items.ts";

let tempDir = "";
let connection: ConnectedDb | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wachi-shared-rss-"));
  connection = await connectDb(join(tempDir, "wachi.db"));
});

afterEach(async () => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }
  connection?.sqlite.close();
  connection = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe("resolveSharedRssValidators", () => {
  it("uses validators only when every destination agrees", () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    const rssUrl = "https://example.com/feed.xml";
    const validators = { etag: '"v1"', lastModified: null };
    persistRssValidators(db, rssUrl, validators, "destination:1");
    persistRssValidators(db, rssUrl, validators, "destination:2");

    expect(
      resolveSharedRssValidators(db, rssUrl, [
        { destinationId: 1, cutoverComplete: true },
        { destinationId: 2, cutoverComplete: true },
      ]),
    ).toEqual(validators);
  });

  it("uses an unconditional request for divergent validators", () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    const rssUrl = "https://example.com/feed.xml";
    persistRssValidators(db, rssUrl, { etag: '"v1"', lastModified: null }, "destination:1");
    persistRssValidators(db, rssUrl, { etag: '"v2"', lastModified: null }, "destination:2");

    expect(
      resolveSharedRssValidators(db, rssUrl, [
        { destinationId: 1, cutoverComplete: true },
        { destinationId: 2, cutoverComplete: true },
      ]),
    ).toBeUndefined();
  });

  it("uses an unconditional request while any destination needs a baseline", () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    const rssUrl = "https://example.com/feed.xml";
    persistRssValidators(db, rssUrl, { etag: '"v1"', lastModified: null }, "destination:1");

    expect(
      resolveSharedRssValidators(db, rssUrl, [
        { destinationId: 1, cutoverComplete: true },
        { destinationId: 2, cutoverComplete: false },
      ]),
    ).toBeUndefined();
  });
});

describe("createSharedRssFetcher", () => {
  it("reuses one parsed document and source identity", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>Shared</title><item><title>One</title><link>/one</link></item></channel></rss>`,
          { headers: { "content-type": "application/rss+xml", etag: '"v1"' } },
        );
      },
    });
    servers.push(server);
    const rssUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    const fetchItems = createSharedRssFetcher({
      db,
      rssUrl,
      rateLimitAcquired: true,
    });

    const [first, second] = await Promise.all([fetchItems(rssUrl), fetchItems(rssUrl)]);

    expect(requests).toBe(1);
    expect(first.items[0]?.link).toBe(`http://127.0.0.1:${server.port}/one`);
    expect(second).toEqual(first);
    expect(first.sourceIdentity?.username).toBe("Shared");
  });

  it("fans out a shared not-modified response", async () => {
    const db = connection?.db;
    if (!db) throw new Error("db not initialized");
    const etag = '"v1"';
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(request.headers.get("if-none-match")).toBe(etag);
        return new Response(null, { status: 304, headers: { etag } });
      },
    });
    servers.push(server);
    const rssUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    const fetchItems = createSharedRssFetcher({
      db,
      rssUrl,
      requestValidators: { etag, lastModified: null },
      rateLimitAcquired: true,
    });

    await expect(fetchItems(rssUrl)).resolves.toEqual({
      notModified: true,
      items: [],
      validators: { etag, lastModified: null },
    });
  });
});
