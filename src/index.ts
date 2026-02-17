#!/usr/bin/env bun
import { defineCommand, runMain, showUsage } from "citty";
import { checkCommand } from "./commands/check.ts";
import { lsCommand } from "./commands/ls.ts";
import { subCommand } from "./commands/sub.ts";
import { testCommand } from "./commands/test.ts";
import { unsubCommand } from "./commands/unsub.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { versionCommand } from "./commands/version.ts";
import { printStdout } from "./lib/cli/io.ts";
import { applyPendingAutoUpdate } from "./lib/update/apply.ts";
import { VERSION } from "./version.ts";

const main = defineCommand({
  meta: {
    name: "wachi",
    description: "Subscribe any link and get notified on change",
    version: VERSION,
  },
  args: {
    version: {
      type: "boolean",
      alias: "v",
      description: "Print version and exit",
      default: false,
    },
  },
  subCommands: {
    sub: subCommand,
    unsub: unsubCommand,
    ls: lsCommand,
    check: checkCommand,
    test: testCommand,
    upgrade: upgradeCommand,
    version: versionCommand,
  },
  run: async ({ args, subCommand }) => {
    if (subCommand) {
      return;
    }

    const positional = "_" in args && Array.isArray(args._) ? args._ : [];
    if (positional.length > 0) {
      return;
    }

    if (args.version === true) {
      printStdout(VERSION);
      process.exit(0);
    }

    await showUsage(main);
  },
});

await applyPendingAutoUpdate().catch(() => {
  return;
});

await runMain(main);
