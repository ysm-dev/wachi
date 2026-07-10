import { describe, expect, it } from "bun:test";
import {
  buildDestinationKey,
  DESTINATION_KEY_VERSION,
} from "../../../../src/lib/notify/destination-identity.ts";

describe("destination identity", () => {
  it("returns a versioned 32-byte key without exposing the destination URL", () => {
    const key = buildDestinationKey("https://api-user:super-secret@example.com/hooks/1");

    expect(DESTINATION_KEY_VERSION).toBe(1);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.byteLength).toBe(32);
    expect(key.toString("utf8")).not.toContain("super-secret");
  });

  it("matches raw Discord webhooks with discord-scheme URLs", () => {
    const raw = buildDestinationKey("https://www.discordapp.com/api/webhooks/123456/token-value");
    const apprise = buildDestinationKey("discord://123456/token-value/");

    expect(raw).toEqual(apprise);
  });

  it("ignores Discord presentation username and avatar", () => {
    const plain = buildDestinationKey("discord://123456/token-value/");
    const personalized = buildDestinationKey(
      "discord://Example%20Feed@123456/token-value/?avatar_url=https%3A%2F%2Fexample.com%2Fa.png",
    );

    expect(personalized).toEqual(plain);
  });

  it("ignores Discord webhook token rotation but includes webhook ID", () => {
    expect(buildDestinationKey("discord://123456/old-token")).toEqual(
      buildDestinationKey("discord://123456/new-token"),
    );
    expect(buildDestinationKey("discord://123456/token")).not.toEqual(
      buildDestinationKey("discord://654321/token"),
    );
  });

  it("sorts destination query parameters deterministically", () => {
    expect(buildDestinationKey("discord://123456/token?wait=true&thread_id=42")).toEqual(
      buildDestinationKey("discord://123456/token?thread_id=42&wait=true"),
    );
  });

  it("keeps Discord query routing differences distinct", () => {
    expect(buildDestinationKey("discord://123456/token?thread_id=42")).not.toEqual(
      buildDestinationKey("discord://123456/token?thread_id=84"),
    );
  });

  it("matches raw Slack webhooks after removing presentation fields", () => {
    const raw = buildDestinationKey(
      "https://hooks.slack.com/services/TA/TB/TC?channel=alerts&mode=blocks",
    );
    const apprise = buildDestinationKey(
      "slack://Feed@TA/TB/TC?mode=blocks&avatar_url=https%3A%2F%2Fexample.com%2Fa.png&channel=alerts",
    );

    expect(raw).toEqual(apprise);
  });

  it("normalizes generic URLs while retaining destination credentials", () => {
    const first = buildDestinationKey(
      "https://api-user:secret@EXAMPLE.COM:443/hooks/1?route=all&format=json",
    );
    const reordered = buildDestinationKey(
      "https://api-user:secret@example.com/hooks/1?format=json&route=all",
    );
    const otherCredentials = buildDestinationKey(
      "https://other-user:secret@example.com/hooks/1?format=json&route=all",
    );

    expect(first).toEqual(reordered);
    expect(first).not.toEqual(otherCredentials);
  });

  it("rejects invalid Apprise URLs without including them in the error", () => {
    expect(() => buildDestinationKey("not-a-secret-url")).toThrow(
      "Destination must be a valid Apprise URL",
    );
  });
});
