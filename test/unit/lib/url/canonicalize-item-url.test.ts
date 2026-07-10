import { describe, expect, it } from "bun:test";
import { canonicalizeItemUrl } from "../../../../src/lib/url/canonicalize-item-url.ts";

describe("canonicalizeItemUrl", () => {
  it("resolves relative links and applies WHATWG normalization", () => {
    const variants = [
      canonicalizeItemUrl("HTTPS://EXAMPLE.COM:443/feed/./Post?x=one%20two#first"),
      canonicalizeItemUrl("../Post?x=one%20two#second", "https://example.com/feed/items/"),
      canonicalizeItemUrl("https://example.com/feed/other/../Post?x=one%20two"),
    ];

    expect(variants).toEqual([
      "https://example.com/feed/Post?x=one%20two",
      "https://example.com/feed/Post?x=one%20two",
      "https://example.com/feed/Post?x=one%20two",
    ]);
  });

  it("removes fragments without changing the rest of the URL", () => {
    expect(canonicalizeItemUrl("https://example.com/Post/?b=2&a=One#section")).toBe(
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
