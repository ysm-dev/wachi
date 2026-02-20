import { access, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { type ParseError, parse as parseJson, printParseErrorCode } from "jsonc-parser";
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

const getLineAndColumn = (content: string, offset: number) => {
  const head = content.slice(0, Math.max(0, offset));
  const lines = head.split(/\r\n|\r|\n/u);
  const line = lines.length;
  const column = (lines[lines.length - 1] ?? "").length + 1;
  return { line, column };
};

const formatJsonParseError = (content: string, error: ParseError, format: "json" | "jsonc") => {
  const location = getLineAndColumn(content, error.offset);
  const reason = printParseErrorCode(error.error);
  return `${format.toUpperCase()} parse error (${reason}) at line ${location.line}, column ${location.column}.`;
};

const parseJsonContent = (content: string): unknown => {
  if (!content.trim()) {
    return {};
  }

  const errors: ParseError[] = [];
  const parsed = parseJson(content, errors, {
    allowEmptyContent: true,
    allowTrailingComma: false,
    disallowComments: true,
  });

  const firstError = errors[0];
  if (firstError) {
    throw new Error(formatJsonParseError(content, firstError, "json"));
  }

  return parsed ?? {};
};

const parseJsoncContent = (content: string): unknown => {
  if (!content.trim()) {
    return {};
  }

  const errors: ParseError[] = [];
  const parsed = parseJson(content, errors, {
    allowEmptyContent: true,
    allowTrailingComma: true,
    disallowComments: false,
  });

  const firstError = errors[0];
  if (firstError) {
    throw new Error(formatJsonParseError(content, firstError, "jsonc"));
  }

  return parsed ?? {};
};

const parseConfigContent = (content: string, format: ConfigFormat): unknown => {
  if (format === "json") {
    return parseJsonContent(content);
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
