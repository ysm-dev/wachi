import { defineCommand } from "citty";
import { z } from "zod";
import { maskAppriseUrl, printJsonSuccess, printStderr, printStdout } from "../lib/cli/io.ts";
import { readConfig } from "../lib/config/read.ts";
import {
  isCssSubscription,
  isRssSubscription,
  type SubscriptionConfig,
} from "../lib/config/schema.ts";
import { writeConfig } from "../lib/config/write.ts";
import { connectDb } from "../lib/db/connect.ts";
import { seedDedupRecords } from "../lib/db/seed-dedup-records.ts";
import { prepareSubscription } from "../lib/subscriptions/prepare-subscription.ts";
import { normalizeUrl } from "../lib/url/normalize.ts";
import { validateAppriseUrl, validateReachableUrl } from "../lib/url/validate.ts";
import {
  commandJson,
  globalArgDefinitions,
  parseCommandArgs,
  runWithErrorHandling,
} from "./shared.ts";

const subArgsSchema = z.object({
  appriseUrl: z.string().min(1),
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
    description: "Subscribe a URL to a notification channel",
  },
  args: {
    ...globalArgDefinitions,
    "send-existing": {
      type: "boolean",
      alias: "e",
      description: "Skip baseline and send all current items on next check",
      default: false,
    },
    appriseUrl: { type: "positional", required: true, description: "Apprise URL" },
    url: { type: "positional", required: true, description: "Subscription URL" },
  },
  run: async ({ args }) => {
    await runWithErrorHandling(args, async () => {
      const parsedArgs = parseCommandArgs(subArgsSchema, args);
      const sendExisting = parsedArgs["send-existing"] === true || parsedArgs.sendExisting === true;
      const isJson = commandJson(parsedArgs);

      validateAppriseUrl(parsedArgs.appriseUrl);
      const normalized = normalizeUrl(parsedArgs.url);
      if (normalized.prependedHttps) {
        printStderr(`Using ${normalized.url}`);
      }
      await validateReachableUrl(normalized.url);

      const configState = await readConfig(parsedArgs.config);
      const existingChannel = configState.config.channels.find(
        (channel) => channel.apprise_url === parsedArgs.appriseUrl,
      );
      const existingSubscription = findExistingSubscription(existingChannel, normalized.url);

      if (existingSubscription) {
        if (isJson) {
          printJsonSuccess({
            type: isCssSubscription(existingSubscription) ? "css" : "rss",
            url: normalized.url,
            rss_url: isRssSubscription(existingSubscription) ? existingSubscription.rss_url : null,
            baseline_count: 0,
          });
        } else {
          printStdout(
            `Already subscribed: ${normalized.url} -> ${maskAppriseUrl(parsedArgs.appriseUrl)}`,
          );
        }
        return 0;
      }

      const prepared = await prepareSubscription(normalized.url, configState.config);
      const nextRawConfig = structuredClone(configState.rawConfig);
      if (!nextRawConfig.channels) {
        nextRawConfig.channels = [];
      }

      const targetChannel = nextRawConfig.channels.find(
        (channel) => channel.apprise_url === parsedArgs.appriseUrl,
      );
      if (targetChannel) {
        targetChannel.subscriptions.push(prepared.subscription);
      } else {
        nextRawConfig.channels.push({
          apprise_url: parsedArgs.appriseUrl,
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
          parsedArgs.appriseUrl,
          normalized.url,
          prepared.baselineItems,
        );
        sqlite.close();
      }

      if (isJson) {
        printJsonSuccess({
          type: prepared.subscriptionType,
          url: normalized.url,
          rss_url: isRssSubscription(prepared.subscription) ? prepared.subscription.rss_url : null,
          baseline_count: sendExisting ? 0 : baselineCount,
        });
      } else if (isRssSubscription(prepared.subscription)) {
        printStdout(`Subscribed (RSS): ${normalized.url}`);
        printStdout(`Feed: ${prepared.subscription.rss_url}`);
        printStdout(`Baseline: ${sendExisting ? 0 : baselineCount} items seeded`);
      } else if (isCssSubscription(prepared.subscription)) {
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
