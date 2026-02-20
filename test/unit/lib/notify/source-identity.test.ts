import { describe, expect, it } from "bun:test";
import {
  normalizeAppriseUrlForIdentity,
  personalizeAppriseUrl,
} from "../../../../src/lib/notify/source-identity.ts";

describe("source identity apprise URL handling", () => {
  it("normalizes discord webhook HTTPS URL to discord scheme", () => {
    const normalized = normalizeAppriseUrlForIdentity(
      "https://discord.com/api/webhooks/123456/abcDEF",
    );

    expect(normalized).toBe("discord://123456/abcDEF/");
  });

  it("normalizes discord URLs consistently across raw and scheme forms", () => {
    const normalizedRaw = normalizeAppriseUrlForIdentity(
      "https://discord.com/api/webhooks/123456/abcDEF",
    );
    const normalizedScheme = normalizeAppriseUrlForIdentity(
      "discord://Example%20Feed@123456/abcDEF/?avatar_url=https%3A%2F%2Fexample.com%2Ficon.png",
    );

    expect(normalizedRaw).toBe(normalizedScheme);
  });

  it("personalizes discord webhook HTTPS URL with username and avatar", () => {
    const personalized = personalizeAppriseUrl("https://discord.com/api/webhooks/123456/abcDEF", {
      username: "Example Feed",
      avatarUrl: "https://example.com/icon.png",
    });

    expect(personalized).toBe(
      "discord://Example%20Feed@123456/abcDEF/?avatar_url=https%3A%2F%2Fexample.com%2Ficon.png",
    );
  });

  it("personalizes Slack webhook HTTPS URL with username", () => {
    const personalized = personalizeAppriseUrl("https://hooks.slack.com/services/TA/TB/TC", {
      username: "My Bot",
      avatarUrl: "https://example.com/icon.png",
    });

    expect(personalized).toBe("slack://My%20Bot@TA/TB/TC");
  });
});
