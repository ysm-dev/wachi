import { describe, expect, it } from "bun:test";
import {
  canonicalizeFeedUrl,
  canonicalizeItemUrl,
} from "../../../../src/lib/url/canonicalize-item-url.ts";

describe("canonicalizeItemUrl", () => {
  it("resolves relative links and applies WHATWG normalization", () => {
    const variants = [
      canonicalizeItemUrl("HTTPS://EXAMPLE.COM:443/feed/./Post?x=one%20two"),
      canonicalizeItemUrl("../Post?x=one%20two", "https://example.com/feed/items/"),
      canonicalizeItemUrl("https://example.com/feed/other/../Post?x=one%20two"),
    ];

    expect(variants).toEqual([
      "https://example.com/feed/Post?x=one%20two",
      "https://example.com/feed/Post?x=one%20two",
      "https://example.com/feed/Post?x=one%20two",
    ]);
  });

  it("preserves fragments so anchor-addressed items stay distinct", () => {
    expect(canonicalizeItemUrl("https://example.com/Post/?b=2&a=One#section")).toBe(
      "https://example.com/Post/?b=2&a=One#section",
    );

    // Per-comment permalinks differ only by fragment; collapsing them would drop items.
    expect(canonicalizeItemUrl("https://news.hada.io/topic?id=32611#cid63660")).not.toBe(
      canonicalizeItemUrl("https://news.hada.io/topic?id=32611#cid63659"),
    );
  });

  it("drops a bare trailing '#' that carries no fragment", () => {
    expect(canonicalizeItemUrl("https://example.com/Post#")).toBe("https://example.com/Post");
    expect(canonicalizeItemUrl("https://example.com/Post?q=1#")).toBe(
      "https://example.com/Post?q=1",
    );
  });

  it("keeps fragment-free links byte-identical so existing delivery keys stay valid", () => {
    expect(canonicalizeItemUrl("https://example.com/Post/?b=2&a=One")).toBe(
      "https://example.com/Post/?b=2&a=One",
    );
  });

  it("preserves conservative URL distinctions", () => {
    const distinctPairs: Array<[string, string]> = [
      ["http://example.com/Post", "https://example.com/Post"],
      ["https://example.com/Post", "https://www.example.com/Post"],
      ["https://example.com/Post", "https://example.com/Post/"],
      ["https://example.com/Post", "https://example.com/post"],
      ["https://example.com/Post?a=1&b=2", "https://example.com/Post?b=2&a=1"],
      ["https://example.com/Post?a=One", "https://example.com/Post?a=one"],
    ];

    for (const [first, second] of distinctPairs) {
      expect(canonicalizeItemUrl(first)).not.toBe(canonicalizeItemUrl(second));
    }
  });

  it("accepts only HTTP and HTTPS URLs", () => {
    expect(canonicalizeItemUrl("ftp://example.com/file")).toBeNull();
    expect(canonicalizeItemUrl("mailto:person@example.com")).toBeNull();
    expect(canonicalizeItemUrl("/relative-without-base")).toBeNull();
    expect(canonicalizeItemUrl("http://[")).toBeNull();
  });
});

describe("canonicalizeFeedUrl", () => {
  it("strips fragments because servers never receive them", () => {
    expect(canonicalizeFeedUrl("https://example.com/feed.xml#fragment")).toBe(
      "https://example.com/feed.xml",
    );
    expect(canonicalizeFeedUrl("https://example.com/feed.xml")).toBe(
      canonicalizeFeedUrl("https://example.com/feed.xml#other"),
    );
  });

  it("accepts only HTTP and HTTPS URLs", () => {
    expect(canonicalizeFeedUrl("ftp://example.com/feed.xml")).toBeNull();
    expect(canonicalizeFeedUrl("")).toBeNull();
  });
});
