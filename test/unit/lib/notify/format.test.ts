import { describe, expect, it } from "bun:test";
import { formatNotificationBody } from "../../../../src/lib/notify/format.ts";

describe("formatNotificationBody", () => {
  it("formats link and title", () => {
    const body = formatNotificationBody("https://example.com", "New Post");
    expect(body).toBe("https://example.com\n\nNew Post");
  });

  it("appends summary when present", () => {
    const body = formatNotificationBody("https://example.com", "New Post", "Short summary");
    expect(body).toBe("https://example.com\n\nNew Post\n\nShort summary");
  });
});
