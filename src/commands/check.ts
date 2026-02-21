import { defineCommand } from "citty";
import { z } from "zod";
import { runCheck } from "../lib/check/run-check.ts";
import {
  commandJson,
  commandVerbose,
  globalArgDefinitions,
  parseCommandArgs,
  runWithErrorHandling,
} from "./shared.ts";

const checkArgsSchema = z.object({
  name: z.string().trim().min(1).optional(),
  concurrency: z.union([z.string(), z.number()]).optional(),
  "dry-run": z.boolean().optional(),
  dryRun: z.boolean().optional(),
  json: z.boolean().optional(),
  verbose: z.boolean().optional(),
  config: z.string().optional(),
});

const resolveConcurrency = (value: string | number | undefined): number => {
  const parsed = Number(value ?? "10");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10;
  }
  return Math.floor(parsed);
};

export const checkCommand = defineCommand({
  meta: {
    name: "check",
    description: "Check all subscriptions for changes",
  },
  args: {
    ...globalArgDefinitions,
    name: {
      type: "string",
      alias: "n",
      required: false,
      description: "Check only one channel name",
    },
    concurrency: {
      type: "string",
      alias: "p",
      required: false,
      default: "10",
      description: "Max concurrent checks",
    },
    "dry-run": {
      type: "boolean",
      alias: "d",
      default: false,
      description: "Show what would be sent without sending",
    },
  },
  run: async ({ args }) => {
    await runWithErrorHandling(args, async () => {
      const parsedArgs = parseCommandArgs(checkArgsSchema, args);
      const dryRun = parsedArgs["dry-run"] === true || parsedArgs.dryRun === true;

      return runCheck({
        name: parsedArgs.name,
        concurrency: resolveConcurrency(parsedArgs.concurrency),
        dryRun,
        isJson: commandJson(parsedArgs),
        isVerbose: commandVerbose(parsedArgs),
        configPath: parsedArgs.config,
      });
    });
  },
});
