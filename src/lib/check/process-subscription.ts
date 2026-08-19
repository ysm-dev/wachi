import { z } from "zod";
import type { LinkTransform, SubscriptionConfig } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { isNetworkLevelError } from "../http/check-connectivity.ts";
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
  subscription: SubscriptionConfig;
  error: unknown;
  networkLevel: boolean;
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
}: ProcessSubscriptionOptions): Promise<void> => {
  try {
    await checkRssSubscription({
      channelName,
      destinationId,
      subscription,
      db,
      dryRun,
      isJson,
      isVerbose,
      stats,
      linkTransforms,
    });
  } catch (error) {
    // Every failure is collected, including confirmed network-level ones. Skipping
    // them here would remove them from the run-wide failure ratio and let a mixed
    // outage (some clean fetch errors, some captive-portal parse errors) slip under
    // the threshold.
    failures.push({
      channelName,
      effectiveChannelUrl,
      subscription,
      error,
      networkLevel: isNetworkLevelError(error),
    });
  }
};
