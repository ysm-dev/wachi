import { describe, expect, it } from "bun:test";
import {
  extractWebsiteBranding,
  fallbackWebsiteFaviconUrl,
  fallbackWebsiteTitle,
  googleS2FaviconUrl,
} from "../../../../src/lib/subscriptions/source-branding.ts";

describe("source-branding", () => {
  it("extracts title and best favicon candidate from HTML", () => {
    const html = `<!doctype html>
<html>
  <head>
    <title>Example News</title>
    <link rel="icon" sizes="16x16" href="/favicon-16.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
    <link rel="icon" sizes="32x32" href="/favicon-32.png" />
  </head>
  <body></body>
</html>`;

    const branding = extractWebsiteBranding("https://example.com/news", html);

    expect(branding.title).toBe("Example News");
    expect(branding.faviconUrl).toBe("https://example.com/apple-touch-icon.png");
  });

  it("builds fallback title and favicon URLs", () => {
    expect(fallbackWebsiteTitle("https://www.example.com/path")).toBe("example.com");
    expect(fallbackWebsiteFaviconUrl("https://www.example.com/path")).toBe(
      "https://www.example.com/favicon.ico",
    );
    expect(googleS2FaviconUrl("https://www.example.com/path")).toBe(
      "https://www.google.com/s2/favicons?domain=www.example.com&sz=128",
    );
  });
});
