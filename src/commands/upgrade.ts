import { defineCommand } from "citty";
import { z } from "zod";
import { printJsonSuccess, printStdout } from "../lib/cli/io.ts";
import { detectInstallMethod } from "../lib/update/detect-method.ts";
import { WachiError } from "../utils/error.ts";
import {
  commandJson,
  globalArgDefinitions,
  parseCommandArgs,
  runWithErrorHandling,
} from "./shared.ts";

const upgradeArgsSchema = z.object({
  json: z.boolean().optional(),
  verbose: z.boolean().optional(),
  config: z.string().optional(),
});

const runAndRequireSuccess = async (command: string[]): Promise<void> => {
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new WachiError(
      "Upgrade command failed",
      `${command.join(" ")} exited with code ${exitCode}.`,
      "Try running the same command manually to inspect your local installation setup.",
    );
  }
};

export const upgradeCommand = defineCommand({
  meta: {
    name: "upgrade",
    description: "Update wachi to latest version",
  },
  args: {
    ...globalArgDefinitions,
  },
  run: async ({ args }) => {
    await runWithErrorHandling(args, async () => {
      const parsedArgs = parseCommandArgs(upgradeArgsSchema, args);
      const method = detectInstallMethod(process.execPath);

      if (method === "npm") {
        await runAndRequireSuccess(["npm", "update", "-g", "wachi"]);
      } else if (method === "brew") {
        await runAndRequireSuccess(["brew", "upgrade", "wachi"]);
      } else {
        throw new WachiError(
          "Automatic upgrade for standalone binary is not available in this build",
          "The current executable appears to be a standalone binary.",
          "Download the latest release binary from GitHub Releases and replace the current file.",
        );
      }

      if (commandJson(parsedArgs)) {
        printJsonSuccess({ upgraded: true, method });
      } else {
        printStdout(`Upgrade complete via ${method}.`);
      }

      return 0;
    });
  },
});
