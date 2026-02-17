import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectRssUrl } from "../../../../src/lib/rss/detect.ts";
import { discoverRssFeedUrl } from "../../../../src/lib/rss/discover.ts";

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
});
