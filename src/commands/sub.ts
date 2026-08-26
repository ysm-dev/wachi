import { defineCommand } from "citty";
import { z } from "zod";
import { flushArchivePool } from "../lib/archive/pool.ts";
import { markDeliveryCutover } from "../lib/check/delivery-cutover.ts";
import { drainDestinationOutbox } from "../lib/check/drain-outbox.ts";
import { type CheckStats, handleSubscriptionItems } from "../lib/check/handle-items.ts";
import { printJsonSuccess, printStderr, printStdout } from "../lib/cli/io.ts";
import { toChannelNameKey } from "../lib/config/channel-name-key.ts";
import { mutateConfig } from "../lib/config/mutate.ts";
import { readConfig } from "../lib/config/read.ts";
import type { SubscriptionConfig } from "../lib/config/schema.ts";
import { connectDb } from "../lib/db/connect.ts";
import { resolveDestinationId } from "../lib/db/delivery-ledger.ts";
import { buildDestinationKey } from "../lib/notify/destination-identity.ts";
import { prepareSubscription } from "../lib/subscriptions/prepare-subscription.ts";
import { resolveSourceIdentity } from "../lib/subscriptions/resolve-source-identity.ts";
import { canonicalizeFeedUrl } from "../lib/url/canonicalize-item-url.ts";
import { normalizeUrl } from "../lib/url/normalize.ts";
import { validateAppriseUrl } from "../lib/url/validate.ts";
import { getEnv } from "../utils/env.ts";
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
  return channel?.subscriptions.find((subscription) => {
    if (subscription.url === normalizedUrl) {
      return true;
    }
    return subscription.rss_url === normalizedUrl;
  });
};

type SubMutationResult = {
  duplicate: SubscriptionConfig | undefined;
  channelIdentity: string;
  channelAppriseUrl: string;
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
    url: {
      type: "positional",
      required: true,
      description: "Subscription URL",
    },
  },
  run: async ({ args }) => {
    await runWithErrorHandling(args, async () => {
      const parsedArgs = parseCommandArgs(subArgsSchema, args);
      const channelName = parsedArgs.name.trim();
      const channelNameKey = toChannelNameKey(channelName);
      const providedAppriseUrl = parsedArgs["apprise-url"] ?? parsedArgs.appriseUrl;
      const sendExisting = parsedArgs["send-existing"] === true || parsedArgs.sendExisting === true;
      const isJson = commandJson(parsedArgs);
      const isVerbose = parsedArgs.verbose === true;

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
        const saved = buildDestinationKey(existingChannel.apprise_url);
        const provided = buildDestinationKey(providedAppriseUrl);
        if (!saved.equals(provided)) {
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
      const existingSubscription = findExistingSubscription(existingChannel, normalized.url);

      if (existingSubscription) {
        if (isJson) {
          printJsonSuccess({
            channel: channelIdentity,
            type: "rss",
            url: existingSubscription.url,
            rss_url: existingSubscription.rss_url,
            baseline_count: 0,
          });
        } else {
          printStdout(`Already subscribed: ${existingSubscription.url} -> ${channelIdentity}`);
        }
        return 0;
      }

      const prepared = await prepareSubscription(normalized.url);
      const preparedRssUrl = canonicalizeFeedUrl(prepared.subscription.rss_url);
      const preparedDuplicate = existingChannel?.subscriptions.find((subscription) => {
        return canonicalizeFeedUrl(subscription.rss_url) === preparedRssUrl;
      });
      if (preparedDuplicate) {
        if (isJson) {
          printJsonSuccess({
            channel: channelIdentity,
            type: "rss",
            url: preparedDuplicate.url,
            rss_url: preparedDuplicate.rss_url,
            baseline_count: 0,
          });
        } else {
          printStdout(`Already subscribed: ${preparedDuplicate.url} -> ${channelIdentity}`);
        }
        return 0;
      }

      const mutation = await mutateConfig<SubMutationResult>(parsedArgs.config, (nextRawConfig) => {
        if (!nextRawConfig.channels) {
          nextRawConfig.channels = [];
        }

        const targetChannel = nextRawConfig.channels.find(
          (channel) => toChannelNameKey(channel.name) === channelNameKey,
        );
        if (!targetChannel && !providedAppriseUrl) {
          throw new WachiError(
            `Channel not found: ${channelName}`,
            `No channel named ${channelName} exists yet in config.`,
            `Create it on first subscribe with: wachi sub -n "${channelName}" -a "<apprise-url>" "${normalized.url}"`,
          );
        }
        if (targetChannel && providedAppriseUrl) {
          const saved = buildDestinationKey(targetChannel.apprise_url);
          const provided = buildDestinationKey(providedAppriseUrl);
          if (!saved.equals(provided)) {
            throw new WachiError(
              `Channel ${targetChannel.name} already exists with a different apprise URL`,
              "The provided --apprise-url does not match the saved channel destination.",
              "Use the existing channel without --apprise-url, or choose a new channel name.",
            );
          }
        }

        const latestIdentity = targetChannel?.name ?? channelName;
        const latestAppriseUrl = targetChannel?.apprise_url ?? providedAppriseUrl;
        if (!latestAppriseUrl) {
          throw new WachiError(
            `Channel not found: ${channelName}`,
            "An apprise URL is required when creating a new channel.",
            `Run: wachi sub -n "${channelName}" -a "<apprise-url>" "${normalized.url}"`,
          );
        }

        const duplicate =
          findExistingSubscription(targetChannel, normalized.url) ??
          targetChannel?.subscriptions.find((subscription) => {
            return canonicalizeFeedUrl(subscription.rss_url) === preparedRssUrl;
          });
        if (duplicate) {
          return {
            result: {
              duplicate,
              channelIdentity: latestIdentity,
              channelAppriseUrl: latestAppriseUrl,
            },
          };
        }

        if (targetChannel) {
          targetChannel.subscriptions.push(prepared.subscription);
        } else {
          nextRawConfig.channels.push({
            name: latestIdentity,
            apprise_url: latestAppriseUrl,
            subscriptions: [prepared.subscription],
          });
        }

        return {
          config: nextRawConfig,
          result: {
            duplicate: undefined,
            channelIdentity: latestIdentity,
            channelAppriseUrl: latestAppriseUrl,
          },
        };
      });
      const latestChannelIdentity = mutation.result.channelIdentity;
      const effectiveChannelUrl = getEnv().appriseUrlOverride ?? mutation.result.channelAppriseUrl;

      if (mutation.result.duplicate) {
        if (isJson) {
          printJsonSuccess({
            channel: latestChannelIdentity,
            type: "rss",
            url: mutation.result.duplicate.url,
            rss_url: mutation.result.duplicate.rss_url,
            baseline_count: 0,
          });
        } else {
          printStdout(
            `Already subscribed: ${mutation.result.duplicate.url} -> ${latestChannelIdentity}`,
          );
        }
        return 0;
      }

      if (!mutation.configState.exists) {
        printStderr(`Created config: ${mutation.configState.path}`);
      }

      const { sqlite, db } = await connectDb();
      let baselineCount = 0;
      try {
        const destinationId = resolveDestinationId(db, buildDestinationKey(effectiveChannelUrl));
        const stats: CheckStats = { sent: [], skipped: 0, errors: [], networkSkipped: 0 };

        if (!sendExisting) {
          const baseIdentity = await resolveSourceIdentity({
            subscriptionUrl: prepared.subscription.url,
            rssUrl: prepared.subscription.rss_url,
          });
          const olderItems = prepared.baselineItems.slice(0, -1);
          baselineCount += await handleSubscriptionItems({
            items: olderItems,
            channelName: latestChannelIdentity,
            destinationId,
            subscriptionUrl: prepared.subscription.url,
            db,
            dryRun: false,
            baseline: true,
            isJson,
            isVerbose,
            stats,
            sourceIdentity: baseIdentity,
            linkTransforms: mutation.configState.config.link_transforms,
            appriseUrl: effectiveChannelUrl,
          });

          const itemsToNotify = prepared.baselineItems.slice(-1);
          if (itemsToNotify.length > 0) {
            baselineCount += await handleSubscriptionItems({
              items: itemsToNotify,
              channelName: latestChannelIdentity,
              destinationId,
              subscriptionUrl: prepared.subscription.url,
              db,
              dryRun: false,
              baseline: false,
              isJson,
              isVerbose,
              stats,
              sourceIdentity: baseIdentity,
              linkTransforms: mutation.configState.config.link_transforms,
              appriseUrl: effectiveChannelUrl,
            });
            await drainDestinationOutbox({
              db,
              destinationId,
              effectiveChannelUrl,
              isJson,
              isVerbose,
              stats,
            });
          }
        }

        markDeliveryCutover(db, destinationId, prepared.subscription.rss_url);
        if (stats.errors.length > 0 && !isJson) {
          printStderr(`Warning: ${stats.errors.join("; ")}`);
        }
        await flushArchivePool();
      } finally {
        sqlite.close();
      }

      if (isJson) {
        printJsonSuccess({
          channel: latestChannelIdentity,
          type: prepared.subscriptionType,
          url: prepared.subscription.url,
          rss_url: prepared.subscription.rss_url,
          baseline_count: sendExisting ? 0 : baselineCount,
        });
      } else {
        printStdout(`Channel: ${latestChannelIdentity}`);
        printStdout(`Subscribed (RSS): ${prepared.subscription.url}`);
        printStdout(`Feed: ${prepared.subscription.rss_url}`);
        printStdout(`Baseline: ${sendExisting ? 0 : baselineCount} items seeded`);
      }

      if (prepared.warning && !isJson) {
        printStderr(prepared.warning);
      }
      return 0;
    });
  },
});
