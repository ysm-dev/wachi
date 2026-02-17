import { defineCommand } from "citty";
import { printStdout } from "../lib/cli/io.ts";
import { VERSION } from "../version.ts";

export const versionCommand = defineCommand({
  meta: {
    name: "version",
    description: "Print version and exit",
  },
  run: () => {
    printStdout(VERSION);
  },
});
