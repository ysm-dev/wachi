import { defineCommand } from "citty";
import { z } from "zod";
import { printJsonSuccess, printStdout } from "../lib/cli/io.ts";
import { toChannelNameKey } from "../lib/config/channel-name-key.ts";
import { readConfig } from "../lib/config/read.ts";
import { isRssSubscription } from "../lib/config/schema.ts";
import { writeConfig } from "../lib/config/write.ts";
import { normalizeUrl } from "../lib/url/normalize.ts";
import {
  commandJson,
  globalArgDefinitions,
  parseCommandArgs,
  runWithErrorHandling,
} from "./shared.ts";

const unsubArgsSchema = z.object({
  name: z.string().trim().min(1),
  url: z.string().optional(),
  json: z.boolean().optional(),
  verbose: z.boolean().optional(),
  config: z.string().optional(),
});

export const unsubCommand = defineCommand({
  meta: {
    name: "unsub",
    description: "Unsubscribe a URL from a named channel or remove an entire channel",
  },
  args: {
    ...globalArgDefinitions,
    name: {
      type: "string",
      alias: "n",
      required: true,
      description: "Channel name",
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
      const channelName = parsedArgs.name.trim();
      const channelNameKey = toChannelNameKey(channelName);

      const configState = await readConfig(parsedArgs.config);
      const nextRaw = structuredClone(configState.rawConfig);
      const channels = nextRaw.channels ?? [];

      const channelIndex = channels.findIndex(
        (channel) => toChannelNameKey(channel.name) === channelNameKey,
      );
      if (channelIndex === -1) {
        if (commandJson(parsedArgs)) {
          printJsonSuccess({ removed: 0 });
        } else {
          printStdout(`Channel not found: ${channelName}`);
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
          printStdout(`Removed channel ${channel.name} (${removedCount} subscriptions)`);
        }
        return 0;
      }

      const normalized = normalizeUrl(parsedArgs.url).url;
      const previousCount = channel.subscriptions.length;
      channel.subscriptions = channel.subscriptions.filter((subscription) => {
        if (subscription.url === normalized) {
          return false;
        }
        return !(isRssSubscription(subscription) && subscription.rss_url === normalized);
      });

      if (channel.subscriptions.length === 0) {
        channels.splice(channelIndex, 1);
      }

      const removed = previousCount - channel.subscriptions.length;
      nextRaw.channels = channels;
      await writeConfig({ config: nextRaw, path: configState.path, format: configState.format });

      if (commandJson(parsedArgs)) {
        printJsonSuccess({ removed });
      } else if (removed > 0) {
        printStdout(`Removed: ${normalized} from ${channel.name}`);
      } else {
        printStdout(`Subscription not found: ${normalized}`);
      }

      return 0;
    });
  },
});
