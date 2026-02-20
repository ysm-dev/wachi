import { chmod, rename, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import { ensureParentDir } from "../../utils/paths.ts";
import { type UserConfig, userConfigSchema } from "./schema.ts";

const writeConfigOptionsSchema = z.object({
  config: z.custom<UserConfig>(),
  path: z.string(),
  format: z.union([z.literal("yaml"), z.literal("json"), z.literal("jsonc")]),
});

type WriteConfigOptions = z.infer<typeof writeConfigOptionsSchema>;

const toConfigText = (config: UserConfig, format: "yaml" | "json" | "jsonc"): string => {
  if (format === "json" || format === "jsonc") {
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  return stringify(config);
};

export const writeConfig = async ({ config, path, format }: WriteConfigOptions): Promise<void> => {
  const validated = userConfigSchema.safeParse(config);
  if (!validated.success) {
    throw new WachiError(
      "Refusing to write invalid config",
      "Config content does not satisfy the schema.",
      "Validate the config object before writing.",
    );
  }

  await ensureParentDir(path);

  const tmpPath = `${path}.tmp`;
  const text = toConfigText(validated.data, format);

  try {
    await writeFile(tmpPath, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    throw new WachiError(
      `Failed to write config at ${path}`,
      error instanceof Error ? error.message : "Could not write config file.",
      "Check filesystem permissions and available disk space, then try again.",
    );
  }
};
