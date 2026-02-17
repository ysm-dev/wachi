import { access, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { WachiError } from "../../utils/error.ts";
import { getDefaultConfigPath, getDefaultJsonConfigPath } from "../../utils/paths.ts";
import { applyConfigDefaults, type UserConfig, userConfigSchema } from "./schema.ts";

type ConfigFormat = "yaml" | "json";

const readConfigResultSchema = z.object({
  config: z.custom<ReturnType<typeof applyConfigDefaults>>(),
  rawConfig: z.custom<UserConfig>(),
  path: z.string(),
  format: z.union([z.literal("yaml"), z.literal("json")]),
  exists: z.boolean(),
});

type ReadConfigResult = z.infer<typeof readConfigResultSchema>;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const detectFormat = (filePath: string): ConfigFormat => {
  return extname(filePath).toLowerCase() === ".json" ? "json" : "yaml";
};

const parseConfigContent = (content: string, format: ConfigFormat): unknown => {
  if (format === "json") {
    if (!content.trim()) {
      return {};
    }
    return JSON.parse(content);
  }

  if (!content.trim()) {
    return {};
  }

  const document = parseDocument(content);
  const parsed = document.toJSON();
  return parsed ?? {};
};

export const readConfig = async (configPathOverride?: string): Promise<ReadConfigResult> => {
  const yamlPath = configPathOverride ?? getDefaultConfigPath();
  const jsonPath = getDefaultJsonConfigPath();

  const explicitPathProvided = Boolean(configPathOverride);
  const resolvedPath = explicitPathProvided
    ? yamlPath
    : (await pathExists(yamlPath))
      ? yamlPath
      : (await pathExists(jsonPath))
        ? jsonPath
        : yamlPath;

  const format = detectFormat(resolvedPath);
  const exists = await pathExists(resolvedPath);

  if (!exists) {
    const rawConfig: UserConfig = {};
    return {
      config: applyConfigDefaults(rawConfig),
      rawConfig,
      path: resolvedPath,
      format,
      exists: false,
    };
  }

  let parsed: unknown;
  try {
    const content = await readFile(resolvedPath, "utf8");
    parsed = parseConfigContent(content, format);
  } catch (error) {
    throw new WachiError(
      `Failed to read config at ${resolvedPath}`,
      error instanceof Error ? error.message : "Could not read the config file.",
      "Check file permissions and config syntax, then try again.",
    );
  }

  const validated = userConfigSchema.safeParse(parsed);
  if (!validated.success) {
    const firstIssue = validated.error.issues[0];
    const path = firstIssue ? firstIssue.path.join(".") : "unknown path";
    const why = fromError(validated.error).toString();
    throw new WachiError(
      `Config validation failed at ${path}`,
      why,
      `Fix the value in ${resolvedPath} at the specified path.`,
    );
  }

  return {
    config: applyConfigDefaults(validated.data),
    rawConfig: validated.data,
    path: resolvedPath,
    format,
    exists: true,
  };
};
