import { defineCommand } from "citty";
import { z } from "zod";
import { printJsonSuccess, printStderr, printStdout } from "../lib/cli/io.ts";
import { toChannelNameKey } from "../lib/config/channel-name-key.ts";
import { readConfig } from "../lib/config/read.ts";
import {
  isCssSubscription,
  isRssSubscription,
  type SubscriptionConfig,
} from "../lib/config/schema.ts";
import { writeConfig } from "../lib/config/write.ts";
import { connectDb } from "../lib/db/connect.ts";
import { seedDedupRecords } from "../lib/db/seed-dedup-records.ts";
import { normalizeAppriseUrlForIdentity } from "../lib/notify/source-identity.ts";
import { prepareSubscription } from "../lib/subscriptions/prepare-subscription.ts";
import { normalizeUrl } from "../lib/url/normalize.ts";
import { validateAppriseUrl, validateReachableUrl } from "../lib/url/validate.ts";
import { WachiError } from "../utils/error.ts";
import {
  commandJson,
  globalArgDefinitions,
  parseCommandArgs,
  runWithErrorHandling,
} from "./shared.ts";

const subArgsSchema = z.object({
  name: z.string().trim().min(1),
  "apprise-url": z.string().optional(),
  appriseUrl: z.string().optional(),
  url: z.string().min(1),
  "send-existing": z.boolean().optional(),
  sendExisting: z.boolean().optional(),
  json: z.boolean().optional(),
  verbose: z.boolean().optional(),
  config: z.string().optional(),
});

const findExistingSubscription = (
  channel: { subscriptions: SubscriptionConfig[] } | undefined,
  normalizedUrl: string,
) => {
  return channel?.subscriptions.find((subscription) => subscription.url === normalizedUrl);
};

export const subCommand = defineCommand({
  meta: {
    name: "sub",
    description: "Subscribe a URL to a named channel",
  },
  args: {
    ...globalArgDefinitions,
    name: {
      type: "string",
      alias: "n",
      required: true,
      description: "Channel name",
    },
    "apprise-url": {
      type: "string",
      alias: "a",
      required: false,
      description: "Apprise URL (required when creating a new channel)",
    },
    "send-existing": {
      type: "boolean",
      alias: "e",
      description: "Skip baseline and send all current items on next check",
      default: false,
    },
    url: { type: "positional", required: true, description: "Subscription URL" },
  },
  run: async ({ args }) => {
    await runWithErrorHandling(args, async () => {
      const parsedArgs = parseCommandArgs(subArgsSchema, args);
      const channelName = parsedArgs.name.trim();
      const channelNameKey = toChannelNameKey(channelName);
      const providedAppriseUrl = parsedArgs["apprise-url"] ?? parsedArgs.appriseUrl;
      const sendExisting = parsedArgs["send-existing"] === true || parsedArgs.sendExisting === true;
      const isJson = commandJson(parsedArgs);

      if (providedAppriseUrl) {
        validateAppriseUrl(providedAppriseUrl);
      }

      const normalized = normalizeUrl(parsedArgs.url);
      if (normalized.prependedHttps) {
        printStderr(`Using ${normalized.url}`);
      }

      const configState = await readConfig(parsedArgs.config);
      const existingChannel = configState.config.channels.find(
        (channel) => toChannelNameKey(channel.name) === channelNameKey,
      );

      if (!existingChannel && !providedAppriseUrl) {
        throw new WachiError(
          `Channel not found: ${channelName}`,
          `No channel named ${channelName} exists yet in config.`,
          `Create it on first subscribe with: wachi sub -n "${channelName}" -a "<apprise-url>" "${normalized.url}"`,
        );
      }

      if (existingChannel && providedAppriseUrl) {
        const saved = normalizeAppriseUrlForIdentity(existingChannel.apprise_url);
        const provided = normalizeAppriseUrlForIdentity(providedAppriseUrl);
        if (saved !== provided) {
          throw new WachiError(
            `Channel ${existingChannel.name} already exists with a different apprise URL`,
            "The provided --apprise-url does not match the saved channel destination.",
            "Use the existing channel without --apprise-url, or choose a new channel name.",
          );
        }
      }

      const channelIdentity = existingChannel?.name ?? channelName;
      const channelAppriseUrl = existingChannel?.apprise_url ?? providedAppriseUrl;
      if (!channelAppriseUrl) {
        throw new WachiError(
          `Channel not found: ${channelName}`,
          "An apprise URL is required when creating a new channel.",
          `Run: wachi sub -n "${channelName}" -a "<apprise-url>" "${normalized.url}"`,
        );
      }

      await validateReachableUrl(normalized.url);

      const existingSubscription = findExistingSubscription(existingChannel, normalized.url);

      if (existingSubscription) {
        if (isJson) {
          printJsonSuccess({
            channel: channelIdentity,
            type: isCssSubscription(existingSubscription) ? "css" : "rss",
            url: normalized.url,
            rss_url: isRssSubscription(existingSubscription) ? existingSubscription.rss_url : null,
            baseline_count: 0,
          });
        } else {
          printStdout(`Already subscribed: ${normalized.url} -> ${channelIdentity}`);
        }
        return 0;
      }

      const prepared = await prepareSubscription(normalized.url, configState.config);
      const nextRawConfig = structuredClone(configState.rawConfig);
      if (!nextRawConfig.channels) {
        nextRawConfig.channels = [];
      }

      const targetChannel = nextRawConfig.channels.find(
        (channel) => toChannelNameKey(channel.name) === channelNameKey,
      );
      if (targetChannel) {
        targetChannel.subscriptions.push(prepared.subscription);
      } else {
        nextRawConfig.channels.push({
          name: channelIdentity,
          apprise_url: channelAppriseUrl,
          subscriptions: [prepared.subscription],
        });
      }

      await writeConfig({
        config: nextRawConfig,
        path: configState.path,
        format: configState.format,
      });
      if (!configState.exists) {
        printStderr(`Created config: ${configState.path}`);
      }

      let baselineCount = 0;
      if (!sendExisting) {
        const { sqlite, db } = await connectDb();
        baselineCount = seedDedupRecords(
          db,
          channelIdentity,
          normalized.url,
          prepared.baselineItems,
        );
        sqlite.close();
      }

      if (isJson) {
        printJsonSuccess({
          channel: channelIdentity,
          type: prepared.subscriptionType,
          url: normalized.url,
          rss_url: isRssSubscription(prepared.subscription) ? prepared.subscription.rss_url : null,
          baseline_count: sendExisting ? 0 : baselineCount,
        });
      } else if (isRssSubscription(prepared.subscription)) {
        printStdout(`Channel: ${channelIdentity}`);
        printStdout(`Subscribed (RSS): ${normalized.url}`);
        printStdout(`Feed: ${prepared.subscription.rss_url}`);
        printStdout(`Baseline: ${sendExisting ? 0 : baselineCount} items seeded`);
      } else if (isCssSubscription(prepared.subscription)) {
        printStdout(`Channel: ${channelIdentity}`);
        printStdout(`Subscribed (CSS): ${normalized.url}`);
        printStdout(`Selector: ${prepared.subscription.item_selector}`);
        printStdout(`Baseline: ${sendExisting ? 0 : baselineCount} items seeded`);
      }

      if (prepared.warning && !isJson) {
        printStderr(prepared.warning);
      }
      return 0;
    });
  },
});
