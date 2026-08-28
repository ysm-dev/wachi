import { z } from "zod";
import type { LinkTransform, SubscriptionConfig } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { markHealthSuccess } from "../db/mark-health-success.ts";
import {
  type FetchRssItemsResult,
  persistRssValidators,
} from "../subscriptions/fetch-rss-subscription-items.ts";
import { markDeliveryCutover } from "./delivery-cutover.ts";
import { recordFeedContinuity, selectContinuousFeedItems } from "./feed-continuity.ts";
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
  attemptGeneration: z.number().int().nonnegative(),
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
  attemptGeneration,
  fetchItems,
}: CheckRssOptions): Promise<void> => {
  const validatorScope = `destination:${destinationId}`;
  const fetched = await fetchItems();

  if (fetched.notModified) {
    if (!dryRun) {
      persistRssValidators(db, subscription.rss_url, fetched.validators, validatorScope, false);
      markHealthSuccess(db, channelName, subscription.url, attemptGeneration);
    }
    return;
  }

  const selected = selectContinuousFeedItems({
    db,
    destinationId,
    rssUrl: subscription.rss_url,
    items: fetched.items,
    cutoverComplete,
  });

  await handleSubscriptionItems({
    items: selected.baselineItems,
    channelName,
    destinationId,
    subscriptionUrl: subscription.url,
    db,
    dryRun,
    baseline: true,
    isJson,
    isVerbose,
    stats,
    sourceIdentity: fetched.sourceIdentity,
    linkTransforms,
    appriseUrl: effectiveChannelUrl,
  });

  await handleSubscriptionItems({
    items: selected.deliveryItems,
    channelName,
    destinationId,
    subscriptionUrl: subscription.url,
    db,
    dryRun,
    // A missing cutover marker must never suppress current items. Existing
    // delivery keys still prevent duplicates after legacy backfill.
    baseline: false,
    isJson,
    isVerbose,
    stats,
    sourceIdentity: fetched.sourceIdentity,
    linkTransforms,
    appriseUrl: effectiveChannelUrl,
  });

  if (!dryRun) {
    recordFeedContinuity(db, destinationId, subscription.rss_url, fetched.items);
    persistRssValidators(db, subscription.rss_url, fetched.validators, validatorScope);
    if (!cutoverComplete) {
      markDeliveryCutover(db, destinationId, subscription.rss_url);
    }
  }

  if (!dryRun) {
    markHealthSuccess(db, channelName, subscription.url, attemptGeneration);
  }
};
