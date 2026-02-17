import { z } from "zod";
import { WachiError } from "../../utils/error.ts";
import type { CssSubscriptionConfig, ResolvedConfig } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { markHealthSuccess } from "../db/mark-health-success.ts";
import { fetchCssSubscriptionItems } from "../subscriptions/fetch-css-subscription-items.ts";
import { type CheckStats, handleSubscriptionItems } from "./handle-items.ts";

type QueueFn = (channelUrl: string, task: () => Promise<void>) => Promise<void>;

const checkCssOptionsSchema = z.object({
  channelUrl: z.string(),
  effectiveChannelUrl: z.string(),
  subscription: z.custom<CssSubscriptionConfig>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  config: z.custom<ResolvedConfig>(),
  stats: z.custom<CheckStats>(),
  enqueueForChannel: z.custom<QueueFn>(),
});

type CheckCssOptions = z.infer<typeof checkCssOptionsSchema>;

export const checkCssSubscription = async ({
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
}: CheckCssOptions): Promise<void> => {
  const items = await fetchCssSubscriptionItems(subscription);
  if (items.length === 0) {
    throw new WachiError(
      `No items matched selector for ${subscription.url}`,
      "The saved CSS selectors returned 0 items.",
      "The site layout likely changed. Re-identify selectors or resubscribe.",
    );
  }

  await handleSubscriptionItems({
    items,
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
