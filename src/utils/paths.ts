import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getEnv } from "./env.ts";

type WachiPaths = {
  config: string;
  data: string;
  cache: string;
};

const getPathOverride = (appName: string): WachiPaths | null => {
  const env = getEnv();
  if (!env.pathsRoot) {
    return null;
  }

  const root = join(resolve(env.pathsRoot), appName);
  return {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
  };
};

const getXdgPaths = (appName: string): WachiPaths => {
  const home = homedir();
  return {
    config: join(process.env.XDG_CONFIG_HOME || join(home, ".config"), appName),
    data: join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), appName),
    cache: join(process.env.XDG_CACHE_HOME || join(home, ".cache"), appName),
  };
};

const getWindowsPaths = (appName: string): WachiPaths => {
  const home = homedir();
  const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  return {
    config: join(appData, appName),
    data: join(localAppData, appName),
    cache: join(localAppData, appName, "cache"),
  };
};

const getMacOsNativePaths = (appName: string): WachiPaths => {
  const home = homedir();
  return {
    config: join(home, "Library", "Preferences", appName),
    data: join(home, "Library", "Application Support", appName),
    cache: join(home, "Library", "Caches", appName),
  };
};

export const getWachiPaths = (appName = "wachi"): WachiPaths => {
  const override = getPathOverride(appName);
  if (override) {
    return override;
  }
  if (process.platform === "win32") {
    return getWindowsPaths(appName);
  }
  return getXdgPaths(appName);
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

export const getLegacyMacOsConfigPath = (): string => {
  return join(getMacOsNativePaths("wachi").config, "config.yml");
};

export const getLegacyMacOsDbPath = (): string => {
  return join(getMacOsNativePaths("wachi").data, "wachi.db");
};

export const getLegacyNodejsDbPath = (): string => {
  const override = getPathOverride("wachi-nodejs");
  if (override) {
    return join(override.data, "wachi.db");
  }
  if (process.platform === "darwin") {
    return join(getMacOsNativePaths("wachi-nodejs").data, "wachi.db");
  }
  if (process.platform === "win32") {
    return join(getWindowsPaths("wachi-nodejs").data, "wachi.db");
  }
  return join(getXdgPaths("wachi-nodejs").data, "wachi.db");
};

export const getPendingUpdatePath = (): string => {
  const paths = getWachiPaths();
  return join(paths.cache, "wachi-new");
};

export const getPendingUpdateStatePath = (): string => {
  const paths = getWachiPaths();
  return join(paths.cache, "update-state.json");
};

export const getPendingUpdateScriptPath = (): string => {
  const paths = getWachiPaths();
  return join(paths.cache, "apply-update.ps1");
};

export const ensureParentDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};
