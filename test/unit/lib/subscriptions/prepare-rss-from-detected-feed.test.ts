import { describe, expect, it } from "bun:test";
import { prepareRssFromDetectedFeed } from "../../../../src/lib/subscriptions/prepare-rss-from-detected-feed.ts";

describe("prepareRssFromDetectedFeed", () => {
  it("uses feed channel link as subscription URL", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/blog/</link>
    <item>
      <title>Post</title>
      <link>/post</link>
      <guid>/post</guid>
    </item>
  </channel>
</rss>`;

    const prepared = await prepareRssFromDetectedFeed("https://example.com/feed.xml", xml);

    expect(prepared.subscriptionType).toBe("rss");
    expect(prepared.subscription).toEqual({
      url: "https://example.com/blog",
      rss_url: "https://example.com/feed.xml",
    });
    expect(prepared.baselineItems).toEqual([{ title: "Post", link: "https://example.com/post" }]);
  });

  it("falls back to RSS URL when feed channel link is missing", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>Post</title>
      <link>https://example.com/post</link>
      <guid>https://example.com/post</guid>
    </item>
  </channel>
</rss>`;

    const prepared = await prepareRssFromDetectedFeed("https://example.com/feed.xml", xml);

    expect(prepared.subscription).toEqual({
      url: "https://example.com/feed.xml",
      rss_url: "https://example.com/feed.xml",
    });
  });
});
