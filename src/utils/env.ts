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
    llmBaseUrl: readEnv("WACHI_LLM_BASE_URL"),
    llmApiKey: readEnv("WACHI_LLM_API_KEY"),
    llmModel: readEnv("WACHI_LLM_MODEL"),
    appriseUrlOverride: readEnv("WACHI_APPRISE_URL"),
    configPath: readEnv("WACHI_CONFIG_PATH"),
    dbPath: readEnv("WACHI_DB_PATH"),
    noAutoUpdate: readEnv("WACHI_NO_AUTO_UPDATE") === "1",
  };
};
