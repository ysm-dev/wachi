import { describe, expect, it } from "bun:test";
import {
  isSafeDiscoveredHttpUrl,
  isSafeResolvedHttpUrl,
} from "../../../../src/lib/url/network-policy.ts";

describe("isSafeDiscoveredHttpUrl", () => {
  it("blocks unsafe schemes and public-to-private discovered URLs", () => {
    expect(isSafeDiscoveredHttpUrl("file:///etc/passwd", "https://example.com/page")).toBe(false);
    expect(isSafeDiscoveredHttpUrl("http://127.0.0.1/feed", "https://example.com/page")).toBe(
      false,
    );
    expect(isSafeDiscoveredHttpUrl("http://[::1]/feed", "https://example.com/page")).toBe(false);
    expect(
      isSafeDiscoveredHttpUrl("http://[::ffff:127.0.0.1]/feed", "https://example.com/page"),
    ).toBe(false);
  });

  it("allows same-host local discovery for explicitly requested local services", () => {
    expect(isSafeDiscoveredHttpUrl("http://127.0.0.1:9000/feed", "http://127.0.0.1/page")).toBe(
      true,
    );
  });
});

describe("isSafeResolvedHttpUrl", () => {
  it("blocks public-looking hostnames that resolve to private addresses", async () => {
    const resolvesPrivate = async () => [{ address: "127.0.0.1" }];

    await expect(
      isSafeResolvedHttpUrl(
        "https://public-looking.example/feed",
        "https://example.com/page",
        resolvesPrivate,
      ),
    ).resolves.toBe(false);
  });

  it("allows hostnames only when every resolved address is public", async () => {
    const resolvesPublic = async () => [
      { address: "8.8.8.8" },
      { address: "2606:4700:4700::1111" },
    ];

    await expect(
      isSafeResolvedHttpUrl(
        "https://feeds.example.com/rss",
        "https://example.com/page",
        resolvesPublic,
      ),
    ).resolves.toBe(true);
  });

  it("allows public IPv6 literals without a DNS lookup", async () => {
    const unexpectedLookup = async (): Promise<Array<{ address: string }>> => {
      throw new Error("lookup should not run");
    };

    await expect(
      isSafeResolvedHttpUrl(
        "https://[2606:4700:4700::1111]/rss",
        "https://example.com/page",
        unexpectedLookup,
      ),
    ).resolves.toBe(true);
  });
});
