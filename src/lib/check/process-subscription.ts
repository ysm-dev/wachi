import { z } from "zod";
import {
  isCssSubscription,
  isRssSubscription,
  type ResolvedConfig,
  type SubscriptionConfig,
  type UserConfig,
} from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { checkCssSubscription } from "./check-css.ts";
import { checkRssSubscription } from "./check-rss.ts";
import { handleSubscriptionFailure } from "./handle-failure.ts";
import type { CheckStats } from "./handle-items.ts";

type QueueFn = (channelUrl: string, task: () => Promise<void>) => Promise<void>;

const processSubscriptionOptionsSchema = z.object({
  channelName: z.string(),
  effectiveChannelUrl: z.string(),
  subscription: z.custom<SubscriptionConfig>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  config: z.custom<ResolvedConfig>(),
  rawConfig: z.custom<UserConfig>(),
  onConfigMutated: z.custom<() => void>(),
  stats: z.custom<CheckStats>(),
  enqueueForChannel: z.custom<QueueFn>(),
});

type ProcessSubscriptionOptions = z.infer<typeof processSubscriptionOptionsSchema>;

export const processSubscriptionCheck = async ({
  channelName,
  effectiveChannelUrl,
  subscription,
  db,
  dryRun,
  isJson,
  isVerbose,
  config,
  rawConfig,
  onConfigMutated,
  stats,
  enqueueForChannel,
}: ProcessSubscriptionOptions): Promise<void> => {
  try {
    if (isRssSubscription(subscription)) {
      await checkRssSubscription({
        channelName,
        effectiveChannelUrl,
        subscription,
        db,
        dryRun,
        isJson,
        isVerbose,
        config,
        stats,
        enqueueForChannel,
      });
      return;
    }

    if (!isCssSubscription(subscription)) {
      return;
    }

    await checkCssSubscription({
      channelName,
      effectiveChannelUrl,
      subscription,
      db,
      dryRun,
      isJson,
      isVerbose,
      config,
      stats,
      enqueueForChannel,
    });
  } catch (error) {
    await handleSubscriptionFailure({
      channelName,
      effectiveChannelUrl,
      subscription,
      db,
      dryRun,
      config,
      rawConfig,
      onConfigMutated,
      stats,
      enqueueForChannel,
      error,
    });
  }
};
