import { describe, expect, it } from "bun:test";
import { shouldArchive } from "../../../../src/lib/archive/url-policy.ts";

describe("shouldArchive", () => {
  it("accepts normal http and https URLs", () => {
    expect(shouldArchive("https://example.com/post")).toBe(true);
    expect(shouldArchive("http://example.com/post")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    expect(shouldArchive("mailto:hello@example.com")).toBe(false);
    expect(shouldArchive("magnet:?xt=urn:btih:123")).toBe(false);
  });

  it("rejects archive hosts to avoid recursion", () => {
    expect(shouldArchive("https://web.archive.org/web/20240101000000/https://example.com")).toBe(
      false,
    );
    expect(shouldArchive("https://archive.ph/abc123")).toBe(false);
    expect(shouldArchive("https://archive.today/example")).toBe(false);
  });

  it("rejects localhost and private network hosts", () => {
    expect(shouldArchive("http://localhost:3000/post")).toBe(false);
    expect(shouldArchive("http://127.0.0.1/post")).toBe(false);
    expect(shouldArchive("http://192.168.0.10/post")).toBe(false);
    expect(shouldArchive("http://172.20.0.5/post")).toBe(false);
    expect(shouldArchive("http://10.0.0.8/post")).toBe(false);
    expect(shouldArchive("https://service.local/post")).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(shouldArchive("not-a-url")).toBe(false);
  });
});
