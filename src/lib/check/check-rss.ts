import { z } from "zod";
import type { ResolvedConfig, RssSubscriptionConfig } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { markHealthSuccess } from "../db/mark-health-success.ts";
import { fetchRssSubscriptionItems } from "../subscriptions/fetch-rss-subscription-items.ts";
import { type CheckStats, handleSubscriptionItems } from "./handle-items.ts";

type QueueFn = (channelUrl: string, task: () => Promise<void>) => Promise<void>;

const checkRssOptionsSchema = z.object({
  channelUrl: z.string(),
  effectiveChannelUrl: z.string(),
  subscription: z.custom<RssSubscriptionConfig>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  config: z.custom<ResolvedConfig>(),
  stats: z.custom<CheckStats>(),
  enqueueForChannel: z.custom<QueueFn>(),
});

type CheckRssOptions = z.infer<typeof checkRssOptionsSchema>;

export const checkRssSubscription = async ({
  channelUrl,
  effectiveChannelUrl,
  subscription,
  db,
  dryRun,
  isJson,
  isVerbose,
  config,
  stats,
  enqueueForChannel,
}: CheckRssOptions): Promise<void> => {
  const fetched = await fetchRssSubscriptionItems({
    subscriptionUrl: subscription.url,
    rssUrl: subscription.rss_url,
    db,
    useConditionalRequest: true,
  });

  if (fetched.notModified) {
    markHealthSuccess(db, channelUrl, subscription.url);
    return;
  }

  await handleSubscriptionItems({
    items: fetched.items,
    channelUrl,
    effectiveChannelUrl,
    subscriptionUrl: subscription.url,
    db,
    dryRun,
    isJson,
    isVerbose,
    config,
    stats,
    enqueueForChannel,
  });

  markHealthSuccess(db, channelUrl, subscription.url);
};
