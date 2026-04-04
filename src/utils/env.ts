const readEnv = (name: string): string | undefined => {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const getEnv = () => {
  return {
    appriseUrlOverride: readEnv("WACHI_APPRISE_URL"),
    configPath: readEnv("WACHI_CONFIG_PATH"),
    dbPath: readEnv("WACHI_DB_PATH"),
    pathsRoot: readEnv("WACHI_PATHS_ROOT"),
    wrapperPath: readEnv("WACHI_WRAPPER_PATH"),
    noAutoUpdate: readEnv("WACHI_NO_AUTO_UPDATE") === "1",
  };
};
