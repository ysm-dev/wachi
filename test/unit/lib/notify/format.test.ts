import { describe, expect, it } from "bun:test";
import { formatNotificationBody } from "../../../../src/lib/notify/format.ts";

describe("formatNotificationBody", () => {
  it("formats link and title", () => {
    const body = formatNotificationBody("https://example.com", "New Post");
    expect(body).toBe("https://example.com\n\nNew Post");
  });

  it("leaves short titles untouched for schemes with a known limit", () => {
    const body = formatNotificationBody("https://example.com", "New Post", "discord://id/token");
    expect(body).toBe("https://example.com\n\nNew Post");
  });

  it("truncates an oversized title so the body fits Discord's 2000-char limit", () => {
    const link = "https://example.com";
    const title = "x".repeat(2500);
    const body = formatNotificationBody(link, title, "discord://id/token");

    expect(body.length).toBeLessThanOrEqual(2000);
    expect(body.startsWith(`${link}\n\n`)).toBe(true);
    expect(body.endsWith("…")).toBe(true);
  });

  it("truncates for raw discord.com webhook URLs too", () => {
    const link = "https://example.com";
    const title = "x".repeat(2500);
    const body = formatNotificationBody(link, title, "https://discord.com/api/webhooks/123/token");

    expect(body.length).toBeLessThanOrEqual(2000);
  });

  it("does not truncate for schemes without a known limit", () => {
    const link = "https://example.com";
    const title = "x".repeat(2500);
    const body = formatNotificationBody(link, title, "mailto://user:pass@example.com");

    expect(body).toBe(`${link}\n\n${title}`);
  });

  it("applies Telegram's 4096-char limit", () => {
    const link = "https://example.com";
    const title = "x".repeat(5000);
    const body = formatNotificationBody(link, title, "tgram://token/chat_id");

    expect(body.length).toBeLessThanOrEqual(4096);
  });
});
