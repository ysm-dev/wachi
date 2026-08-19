import { describe, expect, it } from "bun:test";
import { buildLinkKey, LINK_KEY_VERSION } from "../../../../src/lib/subscriptions/item-identity.ts";

describe("item link identity", () => {
  it("returns a versioned 32-byte link key suitable for a SQLite BLOB", () => {
    const key = buildLinkKey("https://example.com/posts/1");

    expect(LINK_KEY_VERSION).toBe(1);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.byteLength).toBe(32);
  });

  it("matches canonical-equivalent absolute and relative links", () => {
    const absolute = buildLinkKey("HTTPS://EXAMPLE.COM:443/posts/./1");
    const relative = buildLinkKey("../1", "https://example.com/posts/archive/");

    expect(relative).toEqual(absolute);
  });

  it("keeps conservative link variants distinct", () => {
    expect(buildLinkKey("https://example.com/Post")).not.toEqual(
      buildLinkKey("https://example.com/Post/"),
    );
    expect(buildLinkKey("https://example.com/Post?a=1&b=2")).not.toEqual(
      buildLinkKey("https://example.com/Post?b=2&a=1"),
    );
  });

  it("keeps items that differ only by fragment distinct", () => {
    // Anchor-addressed feeds (per-comment permalinks) rely on this to avoid
    // collapsing many items onto one permanent key.
    expect(buildLinkKey("https://news.hada.io/topic?id=32611#cid63660")).not.toEqual(
      buildLinkKey("https://news.hada.io/topic?id=32611#cid63659"),
    );
    expect(buildLinkKey("https://news.hada.io/topic?id=32611#cid63660")).not.toEqual(
      buildLinkKey("https://news.hada.io/topic?id=32611"),
    );
  });

  it("keeps fragment-free keys stable so existing delivery history stays valid", () => {
    // sha256("wachi:link-key:v1\0" + "https://example.com/posts/1")
    expect(buildLinkKey("https://example.com/posts/1").toString("hex")).toBe(
      "419226ded15c2eeab2ec54b60757688aae77c13e1e248b45ffbc74aac32c63e9",
    );
  });

  it("does not depend on a changed item title", () => {
    const firstItem = { title: "Original title", link: "https://example.com/posts/1" };
    const updatedItem = { title: "Changed title", link: "https://example.com/posts/1" };

    expect(buildLinkKey(firstItem.link)).toEqual(buildLinkKey(updatedItem.link));
  });

  it("rejects links that cannot be canonicalized", () => {
    expect(() => buildLinkKey("javascript:alert(1)")).toThrow(
      "Item link must resolve to a valid HTTP or HTTPS URL",
    );
  });
});
