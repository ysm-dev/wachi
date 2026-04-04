import { defineCommand } from "citty";
import { z } from "zod";
import { printJsonSuccess, printStdout } from "../lib/cli/io.ts";
import { detectInstallMethod } from "../lib/update/detect-method.ts";
import { upgradeStandaloneInstall } from "../lib/update/upgrade-standalone.ts";
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
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  } catch {
    throw new WachiError(
      "Upgrade command is unavailable",
      `${command[0]} is not installed or could not be launched from this shell.`,
      `Install ${command[0]} and try again, or upgrade wachi using the same tool you originally installed it with.`,
    );
  }

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
      const method = await detectInstallMethod();
      let upgraded = true;
      let version: string | undefined;
      let status: string | undefined;

      if (method === "npm") {
        await runAndRequireSuccess(["npm", "install", "-g", "wachi@latest"]);
      } else if (method === "bun") {
        await runAndRequireSuccess(["bun", "install", "-g", "wachi@latest"]);
      } else if (method === "brew") {
        await runAndRequireSuccess(["brew", "upgrade", "wachi"]);
      } else if (method === "standalone") {
        const result = await upgradeStandaloneInstall();
        upgraded = result.upgraded;
        version = result.version;
        status = result.status;
      } else if (method === "npx" || method === "bunx") {
        const runner = method === "npx" ? "npx" : "bunx";
        throw new WachiError(
          "Cannot upgrade an ephemeral install",
          `${runner} runs wachi from a temporary cache instead of a persistent installation.`,
          `Run ${runner} wachi@latest ... for the latest version, or install wachi globally before using wachi upgrade.`,
        );
      } else {
        throw new WachiError(
          "Cannot upgrade a project-local install automatically",
          "This wachi executable is running from a project node_modules directory.",
          "Update the dependency in that project with your package manager, then rerun the local binary.",
        );
      }

      if (commandJson(parsedArgs)) {
        printJsonSuccess({ upgraded, method, version, status });
      } else {
        if (method === "standalone") {
          if (!upgraded) {
            printStdout(`Already up to date (${version}).`);
          } else if (status === "scheduled") {
            printStdout(
              `Upgrade to ${version} is scheduled and will finish after this process exits.`,
            );
          } else {
            printStdout(`Upgrade complete via standalone binary (${version}).`);
          }
        } else {
          printStdout(`Upgrade complete via ${method}.`);
        }
      }

      return 0;
    });
  },
});
