import { z } from "zod";
import type { LinkTransform, SubscriptionConfig } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { beginHealthAttempt } from "../db/health-attempt.ts";
import { isNetworkLevelError } from "../http/check-connectivity.ts";
import type { FetchRssItemsResult } from "../subscriptions/fetch-rss-subscription-items.ts";
import { checkRssSubscription } from "./check-rss.ts";
import type { CheckStats } from "./handle-items.ts";

/**
 * A failure captured during the check phase but not yet acted on.
 *
 * Failure handling is deferred until every subscription in the run has been
 * attempted, because the run-wide failure ratio is the signal used to decide
 * whether these are real per-feed failures or one local outage.
 */
export type PendingFailure = {
  channelName: string;
  effectiveChannelUrl: string;
  destinationId: number;
  subscription: SubscriptionConfig;
  error: unknown;
  networkLevel: boolean;
  attemptGeneration: number;
};

const processSubscriptionOptionsSchema = z.object({
  channelName: z.string(),
  effectiveChannelUrl: z.string(),
  destinationId: z.number().int().positive(),
  subscription: z.custom<SubscriptionConfig>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  isJson: z.boolean(),
  isVerbose: z.boolean(),
  stats: z.custom<CheckStats>(),
  failures: z.custom<PendingFailure[]>(),
  linkTransforms: z.custom<LinkTransform[]>(),
  cutoverComplete: z.boolean(),
  fetchItems: z.custom<() => Promise<FetchRssItemsResult>>(),
});

type ProcessSubscriptionOptions = z.infer<typeof processSubscriptionOptionsSchema>;

export const processSubscriptionCheck = async ({
  channelName,
  effectiveChannelUrl,
  destinationId,
  subscription,
  db,
  dryRun,
  isJson,
  isVerbose,
  stats,
  failures,
  linkTransforms,
  cutoverComplete,
  fetchItems,
}: ProcessSubscriptionOptions): Promise<void> => {
  const attemptGeneration = dryRun ? 0 : beginHealthAttempt(db, channelName, subscription.url);
  try {
    await checkRssSubscription({
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
    });
  } catch (error) {
    // Every failure is collected so transport failures can be correlated across
    // hosts after the run, without hiding HTTP or parsing failures.
    failures.push({
      channelName,
      effectiveChannelUrl,
      destinationId,
      subscription,
      error,
      networkLevel: isNetworkLevelError(error),
      attemptGeneration,
    });
  }
};
