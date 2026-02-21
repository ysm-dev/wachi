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

  it("keeps unsupported Discord webhook shapes unchanged", () => {
    const normalized = normalizeAppriseUrlForIdentity(
      "https://discord.com/api/not-webhooks/123?avatar_url=https://example.com/a.png",
    );

    expect(normalized).toBe("https://discord.com/api/not-webhooks/123");
  });

  it("keeps incomplete Discord webhook paths unchanged", () => {
    const normalized = normalizeAppriseUrlForIdentity("https://discord.com/api/webhooks/123");

    expect(normalized).toBe("https://discord.com/api/webhooks/123");
  });

  it("keeps unsupported Slack hosts unchanged", () => {
    const normalized = normalizeAppriseUrlForIdentity(
      "https://example.com/services/TA/TB/TC?avatar_url=https://example.com/a.png",
    );

    expect(normalized).toBe("https://example.com/services/TA/TB/TC");
  });

  it("keeps invalid Slack paths unchanged", () => {
    const normalized = normalizeAppriseUrlForIdentity(
      "https://hooks.slack.com/not-services/TA/TB/TC",
    );

    expect(normalized).toBe("https://hooks.slack.com/not-services/TA/TB/TC");
  });

  it("keeps incomplete Slack service tokens unchanged", () => {
    const normalized = normalizeAppriseUrlForIdentity("https://hooks.slack.com/services/TA/TB");

    expect(normalized).toBe("https://hooks.slack.com/services/TA/TB");
  });

  it("preserves non-avatar query params while normalizing webhook URLs", () => {
    const discordNormalized = normalizeAppriseUrlForIdentity(
      "https://discord.com/api/webhooks/123456/abcDEF?foo=bar",
    );
    const slackNormalized = normalizeAppriseUrlForIdentity(
      "https://hooks.slack.com/services/TA/TB/TC?foo=bar",
    );

    expect(discordNormalized).toBe("discord://123456/abcDEF/?foo=bar");
    expect(slackNormalized).toBe("slack://TA/TB/TC?foo=bar");
  });

  it("returns input unchanged when personalize receives an invalid URL", () => {
    const personalized = personalizeAppriseUrl("not-a-url", { username: "feed" });

    expect(personalized).toBe("not-a-url");
  });

  it("returns input unchanged when normalize receives an invalid URL", () => {
    const normalized = normalizeAppriseUrlForIdentity("not-a-url");

    expect(normalized).toBe("not-a-url");
  });
});
