import { access, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { WachiError } from "../../utils/error.ts";
import {
  getDefaultConfigPath,
  getDefaultJsonConfigPath,
  getDefaultJsoncConfigPath,
} from "../../utils/paths.ts";
import { applyConfigDefaults, type UserConfig, userConfigSchema } from "./schema.ts";

type ConfigFormat = "yaml" | "json" | "jsonc";

const readConfigResultSchema = z.object({
  config: z.custom<ReturnType<typeof applyConfigDefaults>>(),
  rawConfig: z.custom<UserConfig>(),
  path: z.string(),
  format: z.union([z.literal("yaml"), z.literal("json"), z.literal("jsonc")]),
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
  const extension = extname(filePath).toLowerCase();
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".jsonc") {
    return "jsonc";
  }
  return "yaml";
};

const stripJsonComments = (content: string): string => {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? "";
    const next = content[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
        continue;
      }

      if (char === "\n" || char === "\r") {
        result += char;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
};

const stripTrailingJsonCommas = (content: string): string => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? "";

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < content.length && /\s/u.test(content[lookahead] ?? "")) {
        lookahead += 1;
      }

      const nextToken = content[lookahead];
      if (nextToken === "}" || nextToken === "]") {
        continue;
      }
    }

    result += char;
  }

  return result;
};

const parseJsoncContent = (content: string): unknown => {
  if (!content.trim()) {
    return {};
  }

  const withoutComments = stripJsonComments(content);
  const withoutTrailingCommas = stripTrailingJsonCommas(withoutComments);
  const normalized = withoutTrailingCommas.replace(/^\uFEFF/u, "");
  return JSON.parse(normalized);
};

const parseConfigContent = (content: string, format: ConfigFormat): unknown => {
  if (format === "json") {
    if (!content.trim()) {
      return {};
    }
    return JSON.parse(content);
  }

  if (format === "jsonc") {
    return parseJsoncContent(content);
  }

  if (!content.trim()) {
    return {};
  }

  const document = parseDocument(content);
  const parsed = document.toJSON();
  return parsed ?? {};
};

export const readConfig = async (configPathOverride?: string): Promise<ReadConfigResult> => {
  const requestedPath = configPathOverride ?? getDefaultConfigPath();
  const yamlPath = getDefaultConfigPath();
  const jsoncPath = getDefaultJsoncConfigPath();
  const jsonPath = getDefaultJsonConfigPath();

  const explicitPathProvided = Boolean(configPathOverride);
  const resolvedPath = explicitPathProvided
    ? requestedPath
    : (await pathExists(yamlPath))
      ? yamlPath
      : (await pathExists(jsoncPath))
        ? jsoncPath
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
