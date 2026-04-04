import { z } from "zod";
import type { LinkTransform, SubscriptionConfig } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { isNetworkAvailable, isNetworkLevelError } from "../http/check-connectivity.ts";
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
  stats: z.custom<CheckStats>(),
  enqueueForChannel: z.custom<QueueFn>(),
  linkTransforms: z.custom<LinkTransform[]>(),
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
  stats,
  enqueueForChannel,
  linkTransforms,
}: ProcessSubscriptionOptions): Promise<void> => {
  try {
    await checkRssSubscription({
      channelName,
      effectiveChannelUrl,
      subscription,
      db,
      dryRun,
      isJson,
      isVerbose,
      stats,
      enqueueForChannel,
      linkTransforms,
    });
  } catch (error) {
    if (isNetworkLevelError(error) && !(await isNetworkAvailable())) {
      return;
    }

    await handleSubscriptionFailure({
      channelName,
      effectiveChannelUrl,
      subscription,
      db,
      dryRun,
      stats,
      enqueueForChannel,
      error,
    });
  }
};
