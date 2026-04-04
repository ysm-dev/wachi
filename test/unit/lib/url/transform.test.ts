import { describe, expect, it } from "bun:test";
import { transformLink } from "../../../../src/lib/url/transform.ts";

describe("transformLink", () => {
  it("returns original link when transforms array is empty", () => {
    expect(transformLink("https://x.com/user/status/123", [])).toBe(
      "https://x.com/user/status/123",
    );
  });

  it("replaces hostname when from matches", () => {
    const transforms = [{ from: "x.com", to: "fixupx.com" }];
    expect(transformLink("https://x.com/user/status/123", transforms)).toBe(
      "https://fixupx.com/user/status/123",
    );
  });

  it("preserves path, query, and fragment", () => {
    const transforms = [{ from: "x.com", to: "fixupx.com" }];
    expect(transformLink("https://x.com/user/status/123?s=20#top", transforms)).toBe(
      "https://fixupx.com/user/status/123?s=20#top",
    );
  });

  it("matches www variant of hostname", () => {
    const transforms = [{ from: "x.com", to: "fixupx.com" }];
    expect(transformLink("https://www.x.com/user/status/123", transforms)).toBe(
      "https://fixupx.com/user/status/123",
    );
  });

  it("matches when from has www prefix", () => {
    const transforms = [{ from: "www.x.com", to: "fixupx.com" }];
    expect(transformLink("https://x.com/user/status/123", transforms)).toBe(
      "https://fixupx.com/user/status/123",
    );
  });

  it("does not match unrelated hostnames", () => {
    const transforms = [{ from: "x.com", to: "fixupx.com" }];
    expect(transformLink("https://example.com/page", transforms)).toBe("https://example.com/page");
  });

  it("applies first matching transform only", () => {
    const transforms = [
      { from: "x.com", to: "fixupx.com" },
      { from: "x.com", to: "vxtwitter.com" },
    ];
    expect(transformLink("https://x.com/user/status/123", transforms)).toBe(
      "https://fixupx.com/user/status/123",
    );
  });

  it("handles multiple transform rules for different domains", () => {
    const transforms = [
      { from: "x.com", to: "fixupx.com" },
      { from: "twitter.com", to: "fxtwitter.com" },
    ];
    expect(transformLink("https://twitter.com/user/status/456", transforms)).toBe(
      "https://fxtwitter.com/user/status/456",
    );
  });

  it("returns original link for invalid URLs", () => {
    const transforms = [{ from: "x.com", to: "fixupx.com" }];
    expect(transformLink("not-a-url", transforms)).toBe("not-a-url");
  });

  it("preserves protocol (http vs https)", () => {
    const transforms = [{ from: "x.com", to: "fixupx.com" }];
    expect(transformLink("http://x.com/user/status/123", transforms)).toBe(
      "http://fixupx.com/user/status/123",
    );
  });

  it("does not match subdomains beyond www", () => {
    const transforms = [{ from: "x.com", to: "fixupx.com" }];
    expect(transformLink("https://api.x.com/v2/tweets", transforms)).toBe(
      "https://api.x.com/v2/tweets",
    );
  });
});
