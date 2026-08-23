import { defineCommand } from "citty";
import { z } from "zod";
import { printJsonSuccess, printStdout } from "../lib/cli/io.ts";
import { toChannelNameKey } from "../lib/config/channel-name-key.ts";
import { mutateConfig } from "../lib/config/mutate.ts";
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

type UnsubMutationResult =
  | { kind: "missing"; removed: number }
  | { kind: "channel"; removed: number; channelName: string }
  | { kind: "subscription"; removed: number; channelName: string };

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

      const normalized = parsedArgs.url ? normalizeUrl(parsedArgs.url).url : undefined;
      const mutation = await mutateConfig<UnsubMutationResult>(parsedArgs.config, (nextRaw) => {
        const channels = nextRaw.channels ?? [];
        const channelIndex = channels.findIndex(
          (channel) => toChannelNameKey(channel.name) === channelNameKey,
        );
        const channel = channels[channelIndex];
        if (channelIndex === -1 || !channel) {
          return { result: { kind: "missing" as const, removed: 0 } };
        }

        if (!normalized) {
          const removed = channel.subscriptions.length;
          channels.splice(channelIndex, 1);
          nextRaw.channels = channels;
          return {
            config: nextRaw,
            result: { kind: "channel" as const, removed, channelName: channel.name },
          };
        }

        const previousCount = channel.subscriptions.length;
        channel.subscriptions = channel.subscriptions.filter((subscription) => {
          if (subscription.url === normalized) {
            return false;
          }
          return subscription.rss_url !== normalized;
        });
        const removed = previousCount - channel.subscriptions.length;
        if (removed === 0) {
          return {
            result: { kind: "subscription" as const, removed, channelName: channel.name },
          };
        }
        if (channel.subscriptions.length === 0) {
          channels.splice(channelIndex, 1);
        }
        nextRaw.channels = channels;
        return {
          config: nextRaw,
          result: { kind: "subscription" as const, removed, channelName: channel.name },
        };
      });

      if (mutation.result.kind === "missing") {
        if (commandJson(parsedArgs)) {
          printJsonSuccess({ removed: 0 });
        } else {
          printStdout(`Channel not found: ${channelName}`);
        }
        return 0;
      }

      if (mutation.result.kind === "channel") {
        if (commandJson(parsedArgs)) {
          printJsonSuccess({
            removed_channel: true,
            removed_subscriptions: mutation.result.removed,
          });
        } else {
          printStdout(
            `Removed channel ${mutation.result.channelName} (${mutation.result.removed} subscriptions)`,
          );
        }
        return 0;
      }

      if (commandJson(parsedArgs)) {
        printJsonSuccess({ removed: mutation.result.removed });
      } else if (mutation.result.removed > 0) {
        printStdout(`Removed: ${normalized} from ${mutation.result.channelName}`);
      } else {
        printStdout(`Subscription not found: ${normalized}`);
      }

      return 0;
    });
  },
});
