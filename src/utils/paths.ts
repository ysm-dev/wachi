import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import envPaths from "env-paths";
import { getEnv } from "./env.ts";

const getPathOverride = (appName: string) => {
  const env = getEnv();
  if (!env.pathsRoot) {
    return null;
  }

  const root = join(resolve(env.pathsRoot), appName);
  return {
    data: join(root, "data"),
    config: join(root, "config"),
    cache: join(root, "cache"),
    log: join(root, "log"),
    temp: join(root, "tmp"),
  };
};

export const getWachiPaths = (appName = "wachi") => {
  const override = getPathOverride(appName);
  if (override) {
    return override;
  }
  return envPaths(appName, { suffix: "" });
};

export const getDefaultConfigPath = (): string => {
  const env = getEnv();
  if (env.configPath) {
    return env.configPath;
  }
  const paths = getWachiPaths();
  return join(paths.config, "config.yml");
};

export const getDefaultJsonConfigPath = (): string => {
  const paths = getWachiPaths();
  return join(paths.config, "config.json");
};

export const getDefaultJsoncConfigPath = (): string => {
  const paths = getWachiPaths();
  return join(paths.config, "config.jsonc");
};

export const getDefaultDbPath = (): string => {
  const env = getEnv();
  if (env.dbPath) {
    return env.dbPath;
  }
  const paths = getWachiPaths();
  return join(paths.data, "wachi.db");
};

export const getLegacyNodejsDbPath = (): string => {
  const paths = getWachiPaths("wachi-nodejs");
  return join(paths.data, "wachi.db");
};

export const getPendingUpdatePath = (): string => {
  const paths = getWachiPaths();
  return join(paths.cache, "wachi-new");
};

export const ensureParentDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};
