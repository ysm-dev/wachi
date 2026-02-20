import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRssFeed, parseRssItems } from "../../../../src/lib/rss/parse.ts";

const fixturePath = (...parts: string[]): string => {
  return join(process.cwd(), "test", "fixtures", ...parts);
};

describe("parseRssItems", () => {
  it("parses RSS items and sorts oldest first", async () => {
    const xml = await readFile(fixturePath("rss", "basic.xml"), "utf8");
    const items = await parseRssItems(xml, "https://example.com/feed.xml");

    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("Older Post");
    expect(items[1]?.title).toBe("Newer Post");
  });

  it("uses fallback fields for missing title/link", async () => {
    const xml = await readFile(fixturePath("rss", "fallback.xml"), "utf8");
    const items = await parseRssItems(xml, "https://example.com/subscription");

    expect(items[0]?.link).toBe("https://example.com/guid-only");
    expect(items[0]?.title.startsWith("This item has no title field")).toBe(true);
    expect(items[1]?.link).toBe("https://example.com/title-without-link");
    expect(items[1]?.title).toBe("Title Without Link");
  });

  it("throws on malformed feed XML", async () => {
    const xml = await readFile(fixturePath("rss", "malformed.xml"), "utf8");
    await expect(parseRssItems(xml, "https://example.com/feed.xml")).rejects.toBeInstanceOf(Error);
  });

  it("parses atom feeds", async () => {
    const xml = await readFile(fixturePath("rss", "atom.xml"), "utf8");
    const items = await parseRssItems(xml, "https://example.com/atom");

    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Atom Item");
    expect(items[0]?.link).toBe("https://example.com/atom-item");
  });

  it("returns empty list for feeds without items", async () => {
    const xml = await readFile(fixturePath("rss", "empty.xml"), "utf8");
    const items = await parseRssItems(xml, "https://example.com/feed.xml");

    expect(items).toEqual([]);
  });

  it("sets publishedAt to null when feed item has no date", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>No Date Feed</title>
    <item>
      <title>No Date</title>
      <link>https://example.com/no-date</link>
    </item>
  </channel>
</rss>`;

    const items = await parseRssItems(xml, "https://example.com/feed.xml");

    expect(items).toHaveLength(1);
    expect(items[0]?.publishedAt).toBeNull();
  });

  it("sets publishedAt to null when feed date is invalid", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Invalid Date Feed</title>
    <item>
      <title>Bad Date</title>
      <link>https://example.com/bad-date</link>
      <pubDate>not-a-date</pubDate>
    </item>
  </channel>
</rss>`;

    const items = await parseRssItems(xml, "https://example.com/feed.xml");

    expect(items).toHaveLength(1);
    expect(items[0]?.publishedAt).toBeNull();
  });

  it("extracts feed title and image metadata", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Daily Example</title>
    <image>
      <url>https://example.com/logo-512.png</url>
      <title>Daily Example</title>
      <link>https://example.com</link>
    </image>
    <item>
      <title>Item</title>
      <link>https://example.com/item</link>
    </item>
  </channel>
</rss>`;

    const parsed = await parseRssFeed(xml, "https://example.com/feed.xml");

    expect(parsed.title).toBe("Daily Example");
    expect(parsed.imageUrl).toBe("https://example.com/logo-512.png");
    expect(parsed.items).toHaveLength(1);
  });
});
