import type { ArgsDef } from "citty";
import type { z } from "zod";
import { printError } from "../lib/cli/io.ts";
import { toWachiError, WachiError } from "../utils/error.ts";

export const globalArgDefinitions: ArgsDef = {
  json: {
    type: "boolean",
    alias: "j",
    description: "Machine-readable JSON output",
    default: false,
  },
  verbose: {
    type: "boolean",
    alias: "V",
    description: "Show detailed output",
    default: false,
  },
  config: {
    type: "string",
    alias: "C",
    description: "Custom config file path",
    required: false,
  },
};

export type CommandRunArgs = Record<string, unknown>;

export const commandJson = (args: CommandRunArgs): boolean => {
  return args.json === true;
};

export const commandVerbose = (args: CommandRunArgs): boolean => {
  return args.verbose === true;
};

export const runWithErrorHandling = async (
  args: CommandRunArgs,
  run: () => Promise<number | undefined>,
): Promise<void> => {
  try {
    const exitCode = await run();
    if (typeof exitCode === "number") {
      process.exitCode = exitCode;
    }
  } catch (error) {
    const wrapped = toWachiError(error);
    printError(wrapped, commandJson(args));
    process.exitCode = wrapped.exitCode;
  }
};

export const parseCommandArgs = <TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  args: CommandRunArgs,
): z.infer<TSchema> => {
  const parsed = schema.safeParse(args);
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") || "unknown";
  throw new WachiError(
    "Invalid command arguments",
    `Argument validation failed at ${path}.`,
    "Run the command with --help to see valid argument syntax.",
  );
};
