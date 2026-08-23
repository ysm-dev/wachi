import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectRssUrl } from "../../../../src/lib/rss/detect.ts";
import { discoverRssFeedUrl } from "../../../../src/lib/rss/discover.ts";
import { prepareSubscription } from "../../../../src/lib/subscriptions/prepare-subscription.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop();
  }
});

const fixturePath = (...parts: string[]): string => {
  return join(process.cwd(), "test", "fixtures", ...parts);
};

describe("RSS detect/discover", () => {
  it("detectRssUrl identifies RSS content type", async () => {
    const xml = await readFile(fixturePath("rss", "basic.xml"), "utf8");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(xml, { headers: { "content-type": "application/rss+xml" } });
      },
    });
    servers.push(server);

    const detected = await detectRssUrl(`http://127.0.0.1:${server.port}/feed.xml`);
    expect(detected.status).toBe(200);
    expect(detected.isRss).toBe(true);
  });

  it("detectRssUrl identifies RSS body with non-RSS content type", async () => {
    const xml = await readFile(fixturePath("rss", "basic.xml"), "utf8");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(xml, { headers: { "content-type": "text/plain" } });
      },
    });
    servers.push(server);

    const detected = await detectRssUrl(`http://127.0.0.1:${server.port}/feed.xml`);
    expect(detected.status).toBe(200);
    expect(detected.isRss).toBe(true);
  });

  it("detectRssUrl returns false for empty body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("", { headers: { "content-type": "text/plain" } });
      },
    });
    servers.push(server);

    const detected = await detectRssUrl(`http://127.0.0.1:${server.port}/feed.xml`);
    expect(detected.isRss).toBe(false);
  });

  it("detectRssUrl returns false for HTML body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("<!doctype html><html><body>Not RSS</body></html>", {
          headers: { "content-type": "text/plain" },
        });
      },
    });
    servers.push(server);

    const detected = await detectRssUrl(`http://127.0.0.1:${server.port}/page`);
    expect(detected.isRss).toBe(false);
  });

  it("rejects generic XML and XHTML bodies that are not feeds", async () => {
    const bodies = [
      `<?xml version="1.0"?><document><title>Not RSS</title></document>`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>Not RSS</body></html>`,
    ];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const index = new URL(request.url).pathname === "/xhtml" ? 1 : 0;
        return new Response(bodies[index], { headers: { "content-type": "application/xml" } });
      },
    });
    servers.push(server);

    const origin = `http://127.0.0.1:${server.port}`;
    expect((await detectRssUrl(`${origin}/generic`)).isRss).toBe(false);
    expect((await detectRssUrl(`${origin}/xhtml`)).isRss).toBe(false);
  });

  it("reports the effective URL after redirects", async () => {
    const xml = await readFile(fixturePath("rss", "basic.xml"), "utf8");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/old") {
          return Response.redirect(new URL("/feeds/current.xml", request.url), 302);
        }
        return new Response(xml, { headers: { "content-type": "application/rss+xml" } });
      },
    });
    servers.push(server);

    const detected = await detectRssUrl(`http://127.0.0.1:${server.port}/old`);

    expect(detected.url).toBe(`http://127.0.0.1:${server.port}/feeds/current.xml`);
    expect(detected.isRss).toBe(true);
  });

  it("uses effective page and feed URLs for redirected discovery", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Redirected</title>
      <item><title>One</title><link>items/one</link></item>
    </channel></rss>`;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/old-page") {
          return Response.redirect(new URL("/nested/page", request.url), 302);
        }
        if (pathname === "/nested/page") {
          return new Response(
            `<html><head><link rel="alternate" type="application/rss+xml" href="feed.xml"></head></html>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        if (pathname === "/nested/feed.xml") {
          return Response.redirect(new URL("/actual/feed.xml", request.url), 302);
        }
        if (pathname === "/actual/feed.xml") {
          return new Response(xml, { headers: { "content-type": "application/rss+xml" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const origin = `http://127.0.0.1:${server.port}`;
    const prepared = await prepareSubscription(`${origin}/old-page`);

    expect(prepared.subscription).toEqual({
      url: `${origin}/nested/page`,
      rss_url: `${origin}/actual/feed.xml`,
    });
    expect(prepared.baselineItems).toEqual([
      { title: "One", link: `${origin}/actual/items/one`, publishedAt: null },
    ]);
  });

  it("prepares a direct RSS feed", async () => {
    const xml = await readFile(fixturePath("rss", "basic.xml"), "utf8");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(xml, { headers: { "content-type": "application/rss+xml" } });
      },
    });
    servers.push(server);

    const feedUrl = `http://127.0.0.1:${server.port}/feed.xml`;
    const prepared = await prepareSubscription(feedUrl);

    expect(prepared.subscription.rss_url).toBe(feedUrl);
    expect(prepared.subscriptionType).toBe("rss");
    expect(prepared.baselineItems.length).toBeGreaterThan(0);
  });

  it("reports an unavailable subscription URL", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not found", { status: 404, statusText: "Not Found" });
      },
    });
    servers.push(server);

    await expect(prepareSubscription(`http://127.0.0.1:${server.port}/missing`)).rejects.toThrow(
      "Failed to reach",
    );
  });

  it("reports when an HTML page has no discoverable feed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/page") {
          return new Response("<html><body>No feeds here</body></html>", {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    await expect(prepareSubscription(`http://127.0.0.1:${server.port}/page`)).rejects.toThrow(
      "No RSS feed found",
    );
  });

  it("discoverRssFeedUrl finds alternate feed links from HTML fixture", async () => {
    const html = await readFile(fixturePath("html", "page-with-rss-link.html"), "utf8");
    const xml = await readFile(fixturePath("rss", "basic.xml"), "utf8");

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/feed.xml") {
          return new Response(xml, { headers: { "content-type": "application/rss+xml" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const pageUrl = `http://127.0.0.1:${server.port}/blog`;
    const discovered = await discoverRssFeedUrl(pageUrl, html);

    expect(discovered).toBe(`http://127.0.0.1:${server.port}/feed.xml`);
  });

  it("discoverRssFeedUrl accepts feed XML served as text/plain", async () => {
    const html = await readFile(fixturePath("html", "page-with-rss-link.html"), "utf8");
    const xml = await readFile(fixturePath("rss", "basic.xml"), "utf8");

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/feed.xml") {
          return new Response(xml, { headers: { "content-type": "text/plain" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const pageUrl = `http://127.0.0.1:${server.port}/blog`;
    const discovered = await discoverRssFeedUrl(pageUrl, html);

    expect(discovered).toBe(`http://127.0.0.1:${server.port}/feed.xml`);
  });

  it("discoverRssFeedUrl returns null when no candidate feed is valid", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const pageUrl = `http://127.0.0.1:${server.port}/blog`;
    const discovered = await discoverRssFeedUrl(pageUrl, "<html><body>No feeds here</body></html>");

    expect(discovered).toBeNull();
  });

  it("ignores alternate links that do not include href", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const pageUrl = `http://127.0.0.1:${server.port}/blog`;
    const html = `<html><head><link rel="alternate" type="application/rss+xml"></head></html>`;
    const discovered = await discoverRssFeedUrl(pageUrl, html);

    expect(discovered).toBeNull();
  });

  it("bounds alternate feed candidates", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const pageUrl = `http://127.0.0.1:${server.port}/blog`;
    const alternates = Array.from(
      { length: 50 },
      (_, index) =>
        `<link rel="alternate" type="application/rss+xml" href="/candidate-${index}.xml">`,
    ).join("");
    const discovered = await discoverRssFeedUrl(pageUrl, `<html><head>${alternates}</head></html>`);

    expect(discovered).toBeNull();
    expect(requests).toBeLessThanOrEqual(24);
  });
});
