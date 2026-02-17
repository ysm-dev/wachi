import { describe, expect, it } from "bun:test";
import {
  applyConfigDefaults,
  isCssSubscription,
  isRssSubscription,
} from "../../../../src/lib/config/schema.ts";

describe("config schema", () => {
  it("applies defaults for empty config", () => {
    const config = applyConfigDefaults({});
    expect(config.channels).toEqual([]);
    expect(config.cleanup.ttl_days).toBe(90);
    expect(config.cleanup.max_records).toBe(50000);
    expect(config.summary.enabled).toBe(false);
    expect(config.summary.language).toBe("en");
  });

  it("detects rss and css subscription kinds", () => {
    const rss = { url: "https://example.com", rss_url: "https://example.com/feed.xml" };
    const css = {
      url: "https://example.com",
      item_selector: ".item",
      title_selector: "a",
      link_selector: "a",
    };

    expect(isRssSubscription(rss)).toBe(true);
    expect(isCssSubscription(rss)).toBe(false);
    expect(isCssSubscription(css)).toBe(true);
    expect(isRssSubscription(css)).toBe(false);
  });
});
