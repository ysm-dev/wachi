import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readConfig } from "../../../../src/lib/config/read.ts";
import { writeConfig } from "../../../../src/lib/config/write.ts";
import { WachiError } from "../../../../src/utils/error.ts";
import { getDefaultJsonConfigPath } from "../../../../src/utils/paths.ts";

const tempDirs: string[] = [];
const envSnapshot = {
  HOME: process.env.HOME,
  WACHI_CONFIG_PATH: process.env.WACHI_CONFIG_PATH,
};

afterEach(async () => {
  process.env.HOME = envSnapshot.HOME;
  process.env.WACHI_CONFIG_PATH = envSnapshot.WACHI_CONFIG_PATH;
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("config read/write", () => {
  it("writes and reads YAML config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-test-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.yml");

    await writeConfig({
      path: configPath,
      format: "yaml",
      config: {
        channels: [
          {
            apprise_url: "slack://token/channel",
            subscriptions: [
              { url: "https://example.com", rss_url: "https://example.com/feed.xml" },
            ],
          },
        ],
      },
    });

    const read = await readConfig(configPath);
    expect(read.exists).toBe(true);
    expect(read.format).toBe("yaml");
    expect(read.config.channels).toHaveLength(1);
  });

  it("writes and reads JSON config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-test-json-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");

    await writeConfig({
      path: configPath,
      format: "json",
      config: {
        channels: [
          {
            apprise_url: "discord://hook/id",
            subscriptions: [
              { url: "https://example.com", rss_url: "https://example.com/feed.xml" },
            ],
          },
        ],
      },
    });

    const read = await readConfig(configPath);
    expect(read.exists).toBe(true);
    expect(read.format).toBe("json");
    expect(read.config.channels[0]?.apprise_url).toBe("discord://hook/id");
  });

  it("returns defaults when config file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-test-missing-"));
    tempDirs.push(dir);
    const configPath = join(dir, "missing.yml");

    const read = await readConfig(configPath);
    expect(read.exists).toBe(false);
    expect(read.config.channels).toEqual([]);
    expect(read.config.cleanup.ttl_days).toBe(90);
  });

  it("treats empty yaml config as defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-test-empty-yaml-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.yml");
    await writeFile(configPath, "   \n", "utf8");

    const read = await readConfig(configPath);
    expect(read.exists).toBe(true);
    expect(read.format).toBe("yaml");
    expect(read.config.channels).toEqual([]);
  });

  it("prefers config.json when config.yml is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "wachi-home-"));
    tempDirs.push(home);
    process.env.HOME = home;
    delete process.env.WACHI_CONFIG_PATH;

    const jsonPath = getDefaultJsonConfigPath();
    const configDir = dirname(jsonPath);
    await mkdir(configDir, { recursive: true });
    await writeFile(
      jsonPath,
      JSON.stringify({ channels: [{ apprise_url: "slack://x/y", subscriptions: [] }] }),
      "utf8",
    );

    const read = await readConfig();
    expect(read.path.endsWith("config.json")).toBe(true);
    expect(read.config.channels).toHaveLength(1);
  });

  it("throws WachiError for invalid config content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-test-invalid-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.yml");
    await writeFile(
      configPath,
      "channels:\n  - apprise_url: slack://x/y\n    subscriptions:\n      - url: not-a-url\n        rss_url: not-a-url\n",
      "utf8",
    );

    await expect(readConfig(configPath)).rejects.toBeInstanceOf(WachiError);
  });

  it("throws WachiError for malformed json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-test-badjson-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");
    await writeFile(configPath, "{", "utf8");

    await expect(readConfig(configPath)).rejects.toBeInstanceOf(WachiError);
  });

  it("treats empty json config as defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-test-empty-json-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");
    await writeFile(configPath, "   ", "utf8");

    const read = await readConfig(configPath);
    expect(read.exists).toBe(true);
    expect(read.format).toBe("json");
    expect(read.config.channels).toEqual([]);
  });

  it("rejects writing invalid config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-test-invalid-write-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.yml");

    await expect(
      writeConfig({
        path: configPath,
        format: "yaml",
        config: {
          channels: [
            {
              apprise_url: "slack://x/y",
              subscriptions: [{ url: "not-a-url", rss_url: "https://example.com/feed.xml" }],
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(WachiError);
  });

  it("wraps filesystem write errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wachi-test-fs-"));
    tempDirs.push(dir);
    const locked = join(dir, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o500);

    try {
      await expect(
        writeConfig({
          path: join(locked, "config.yml"),
          format: "yaml",
          config: { channels: [] },
        }),
      ).rejects.toBeInstanceOf(WachiError);
    } finally {
      await chmod(locked, 0o700);
    }
  });
});
