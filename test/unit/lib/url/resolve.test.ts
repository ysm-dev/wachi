import { describe, expect, it } from "bun:test";
import { resolveUrl } from "../../../../src/lib/url/resolve.ts";

describe("resolveUrl", () => {
  it("resolves relative URL against base", () => {
    const resolved = resolveUrl("/posts/1", "https://example.com/blog");
    expect(resolved).toBe("https://example.com/posts/1");
  });

  it("returns base URL when link is invalid", () => {
    const resolved = resolveUrl("http://[", "https://example.com");
    expect(resolved).toBe("https://example.com");
  });
});
