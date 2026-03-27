import { describe, expect, it } from "bun:test";
import { applyConfigDefaults, userConfigSchema } from "../../../../src/lib/config/schema.ts";

describe("config schema", () => {
  it("applies defaults for empty config", () => {
    const config = applyConfigDefaults({});
    expect(config.channels).toEqual([]);
    expect(config.cleanup.ttl_days).toBe(90);
    expect(config.cleanup.max_records).toBe(50000);
  });

  it("requires channel names", () => {
    const parsed = userConfigSchema.safeParse({
      channels: [{ apprise_url: "slack://token/channel", subscriptions: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate channel names case-insensitively", () => {
    const parsed = userConfigSchema.safeParse({
      channels: [
        { name: "Main", apprise_url: "slack://token/channel", subscriptions: [] },
        { name: "main", apprise_url: "discord://hook/id", subscriptions: [] },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) => issue.message.includes("Channel names must be unique")),
      ).toBe(true);
    }
  });
});
