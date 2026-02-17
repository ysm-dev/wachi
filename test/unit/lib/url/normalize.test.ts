import { describe, expect, it } from "bun:test";
import { normalizeUrl } from "../../../../src/lib/url/normalize.ts";

describe("normalizeUrl", () => {
  it("prepends https when protocol is missing", () => {
    const normalized = normalizeUrl("example.com");
    expect(normalized.url).toBe("https://example.com");
    expect(normalized.prependedHttps).toBe(true);
  });

  it("strips trailing slash", () => {
    const normalized = normalizeUrl("https://example.com/");
    expect(normalized.url).toBe("https://example.com");
  });
});
