import { defineCommand } from "citty";
import { z } from "zod";
import { maskAppriseUrl, printJsonSuccess, printStdout } from "../lib/cli/io.ts";
import { readConfig } from "../lib/config/read.ts";
import { isCssSubscription, isRssSubscription } from "../lib/config/schema.ts";
import { connectDb } from "../lib/db/connect.ts";
import { listHealthStates } from "../lib/db/list-health-states.ts";
import {
  commandJson,
  globalArgDefinitions,
  parseCommandArgs,
  runWithErrorHandling,
} from "./shared.ts";

const lsArgsSchema = z.object({
  json: z.boolean().optional(),
  verbose: z.boolean().optional(),
  config: z.string().optional(),
});

export const lsCommand = defineCommand({
  meta: {
    name: "ls",
    description: "List all channels and subscriptions",
  },
  args: {
    ...globalArgDefinitions,
  },
  run: async ({ args }) => {
    await runWithErrorHandling(args, async () => {
      const parsedArgs = parseCommandArgs(lsArgsSchema, args);
      const configState = await readConfig(parsedArgs.config);

      const { sqlite, db } = await connectDb();
      const health = listHealthStates(db);
      sqlite.close();

      const failuresByKey = new Map<string, number>();
      for (const state of health) {
        const key = `${state.channelUrl}::${state.subscriptionUrl}`;
        failuresByKey.set(key, state.consecutiveFailures);
      }

      if (commandJson(parsedArgs)) {
        printJsonSuccess({
          channels: configState.config.channels,
        });
        return 0;
      }

      if (configState.config.channels.length === 0) {
        printStdout("No subscriptions yet.");
        return 0;
      }

      for (const channel of configState.config.channels) {
        printStdout(`${channel.name} (${maskAppriseUrl(channel.apprise_url)})`);

        for (const subscription of channel.subscriptions) {
          const type = isRssSubscription(subscription)
            ? "RSS"
            : isCssSubscription(subscription)
              ? "CSS"
              : "Unknown";

          const failureKey = `${channel.name}::${subscription.url}`;
          const failures = failuresByKey.get(failureKey) ?? 0;
          const healthSuffix = failures > 0 ? ` [${failures} failures]` : "";
          printStdout(`  ${subscription.url} (${type})${healthSuffix}`);
        }

        printStdout("");
      }

      return 0;
    });
  },
});
