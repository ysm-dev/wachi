import { defineCommand } from "citty";
import { z } from "zod";
import { maskAppriseUrl, printJsonSuccess, printStdout } from "../lib/cli/io.ts";
import { readConfig } from "../lib/config/read.ts";
import { writeConfig } from "../lib/config/write.ts";
import { normalizeUrl } from "../lib/url/normalize.ts";
import { validateAppriseUrl } from "../lib/url/validate.ts";
import {
  commandJson,
  globalArgDefinitions,
  parseCommandArgs,
  runWithErrorHandling,
} from "./shared.ts";

const unsubArgsSchema = z.object({
  appriseUrl: z.string().min(1),
  url: z.string().optional(),
  json: z.boolean().optional(),
  verbose: z.boolean().optional(),
  config: z.string().optional(),
});

export const unsubCommand = defineCommand({
  meta: {
    name: "unsub",
    description: "Unsubscribe a URL from a channel or remove an entire channel",
  },
  args: {
    ...globalArgDefinitions,
    appriseUrl: {
      type: "positional",
      required: true,
      description: "Apprise URL",
    },
    url: {
      type: "positional",
      required: false,
      description: "Subscription URL (optional)",
    },
  },
  run: async ({ args }) => {
    await runWithErrorHandling(args, async () => {
      const parsedArgs = parseCommandArgs(unsubArgsSchema, args);
      validateAppriseUrl(parsedArgs.appriseUrl);

      const configState = await readConfig(parsedArgs.config);
      const nextRaw = structuredClone(configState.rawConfig);
      const channels = nextRaw.channels ?? [];

      const channelIndex = channels.findIndex(
        (channel) => channel.apprise_url === parsedArgs.appriseUrl,
      );
      if (channelIndex === -1) {
        if (commandJson(parsedArgs)) {
          printJsonSuccess({ removed: 0 });
        } else {
          printStdout(`Channel not found: ${maskAppriseUrl(parsedArgs.appriseUrl)}`);
        }
        return 0;
      }

      const channel = channels[channelIndex];
      if (!channel) {
        return 0;
      }

      if (!parsedArgs.url) {
        const removedCount = channel.subscriptions.length;
        channels.splice(channelIndex, 1);
        nextRaw.channels = channels;
        await writeConfig({ config: nextRaw, path: configState.path, format: configState.format });

        if (commandJson(parsedArgs)) {
          printJsonSuccess({ removed_channel: true, removed_subscriptions: removedCount });
        } else {
          printStdout(
            `Removed channel ${maskAppriseUrl(parsedArgs.appriseUrl)} (${removedCount} subscriptions)`,
          );
        }
        return 0;
      }

      const normalized = normalizeUrl(parsedArgs.url).url;
      const previousCount = channel.subscriptions.length;
      channel.subscriptions = channel.subscriptions.filter(
        (subscription) => subscription.url !== normalized,
      );

      if (channel.subscriptions.length === 0) {
        channels.splice(channelIndex, 1);
      }

      const removed = previousCount - channel.subscriptions.length;
      nextRaw.channels = channels;
      await writeConfig({ config: nextRaw, path: configState.path, format: configState.format });

      if (commandJson(parsedArgs)) {
        printJsonSuccess({ removed });
      } else if (removed > 0) {
        printStdout(`Removed: ${normalized} from ${maskAppriseUrl(parsedArgs.appriseUrl)}`);
      } else {
        printStdout(`Subscription not found: ${normalized}`);
      }

      return 0;
    });
  },
});
