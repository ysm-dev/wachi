import { afterEach, describe, expect, it } from "bun:test";
import { getEnv } from "../../../src/utils/env.ts";

const keys = [
  "WACHI_APPRISE_URL",
  "WACHI_CONFIG_PATH",
  "WACHI_DB_PATH",
  "WACHI_NO_AUTO_UPDATE",
] as const;

const snapshot = new Map<string, string | undefined>();
for (const key of keys) {
  snapshot.set(key, process.env[key]);
}

afterEach(() => {
  for (const key of keys) {
    const original = snapshot.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

describe("getEnv", () => {
  it("trims and reads env variables", () => {
    process.env.WACHI_APPRISE_URL = " slack://token/channel ";
    process.env.WACHI_CONFIG_PATH = " /tmp/config.yml ";
    process.env.WACHI_DB_PATH = " /tmp/wachi.db ";
    process.env.WACHI_NO_AUTO_UPDATE = "1";

    const env = getEnv();
    expect(env.appriseUrlOverride).toBe("slack://token/channel");
    expect(env.configPath).toBe("/tmp/config.yml");
    expect(env.dbPath).toBe("/tmp/wachi.db");
    expect(env.noAutoUpdate).toBe(true);
  });

  it("returns undefined for empty values", () => {
    process.env.WACHI_NO_AUTO_UPDATE = "0";
    const env = getEnv();
    expect(env.noAutoUpdate).toBe(false);
  });
});
