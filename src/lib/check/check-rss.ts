import { z } from "zod";
import type { LinkTransform, SubscriptionConfig } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { markHealthSuccess } from "../db/mark-health-success.ts";
import {
  type FetchRssItemsResult,
  persistRssValidators,
} from "../subscriptions/fetch-rss-subscription-items.ts";
import { markDeliveryCutover } from "./delivery-cutover.ts";
import { type CheckStats, handleSubscriptionItems } from "./handle-items.ts";

const checkRssOptionsSchema = z.object({
  channelName: z.string(),
  effectiveChannelUrl: z.string(),
  destinationId: z.number().int().positive(),
  subscription: z.custom<SubscriptionConfig>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  stats: z.custom<CheckStats>(),
  linkTransforms: z.custom<LinkTransform[]>(),
  cutoverComplete: z.boolean(),
  fetchItems: z.custom<() => Promise<FetchRssItemsResult>>(),
});

type CheckRssOptions = z.infer<typeof checkRssOptionsSchema>;

export const checkRssSubscription = async ({
  channelName,
  effectiveChannelUrl,
  destinationId,
  subscription,
  db,
  dryRun,
  isJson,
  isVerbose,
  stats,
  linkTransforms,
  cutoverComplete,
  fetchItems,
}: CheckRssOptions): Promise<void> => {
  const validatorScope = `destination:${destinationId}`;
  const fetched = await fetchItems();

  if (fetched.notModified) {
    markHealthSuccess(db, channelName, subscription.url);
    return;
  }

  await handleSubscriptionItems({
    items: fetched.items,
    channelName,
    destinationId,
    subscriptionUrl: subscription.url,
    db,
    dryRun,
    baseline: !cutoverComplete,
    isJson,
    isVerbose,
    stats,
    sourceIdentity: fetched.sourceIdentity,
    linkTransforms,
    appriseUrl: effectiveChannelUrl,
  });

  if (!dryRun) {
    persistRssValidators(db, subscription.rss_url, fetched.validators, validatorScope);
    if (!cutoverComplete) {
      markDeliveryCutover(db, destinationId, subscription.rss_url);
    }
  }

  markHealthSuccess(db, channelName, subscription.url);
};
