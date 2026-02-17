import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import envPaths from "env-paths";
import { getEnv } from "./env.ts";

export const getWachiPaths = () => {
  return envPaths("wachi", { suffix: "" });
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

export const getDefaultDbPath = (): string => {
  const env = getEnv();
  if (env.dbPath) {
    return env.dbPath;
  }
  const paths = getWachiPaths();
  return join(paths.data, "wachi.db");
};

export const getPendingUpdatePath = (): string => {
  const paths = getWachiPaths();
  return join(paths.cache, "wachi-new");
};

export const ensureParentDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};
