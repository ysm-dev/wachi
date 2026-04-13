import { z } from "zod";
import type { SubscriptionConfig } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { markHealthFailure } from "../db/mark-health-failure.ts";
import { sendNotification } from "../notify/send.ts";
import {
  resolveSourceIdentity,
  withLinkFallbackAvatar,
} from "../subscriptions/resolve-source-identity.ts";
import type { CheckStats } from "./handle-items.ts";

type QueueFn = (channelUrl: string, task: () => Promise<void>) => Promise<void>;

const handleFailureOptionsSchema = z.object({
  channelName: z.string(),
  effectiveChannelUrl: z.string(),
  subscription: z.custom<SubscriptionConfig>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  stats: z.custom<CheckStats>(),
  enqueueForChannel: z.custom<QueueFn>(),
  error: z.unknown(),
});

type HandleFailureOptions = z.infer<typeof handleFailureOptionsSchema>;

const maybeSendFailureAlert = async (
  failures: number,
  subscription: SubscriptionConfig,
  message: string,
  channelName: string,
  effectiveChannelUrl: string,
  dryRun: boolean,
  enqueueForChannel: QueueFn,
  db: WachiDb,
): Promise<void> => {
  const isMilestone = failures > 100 && failures % 100 === 0;
  if (!(failures === 10 || failures === 100 || isMilestone) || dryRun) {
    return;
  }

  const body =
    failures === 10
      ? `wachi: subscription ${subscription.url} has failed 10 consecutive checks. Last error: ${message}`
      : `wachi: subscription ${subscription.url} has been failing for ${failures} consecutive checks. Consider removing it with wachi unsub -n "${channelName}".`;

  try {
    const baseIdentity = await resolveSourceIdentity({
      subscriptionUrl: subscription.url,
      rssUrl: subscription.rss_url,
      db,
      allowFeedFetch: false,
    });
    const sourceIdentity = withLinkFallbackAvatar(baseIdentity, subscription.url);
    await enqueueForChannel(effectiveChannelUrl, async () => {
      await sendNotification({
        appriseUrl: effectiveChannelUrl,
        body,
        sourceIdentity,
      });
    });
  } catch {
    return;
  }
};

export const handleSubscriptionFailure = async ({
  channelName,
  effectiveChannelUrl,
  subscription,
  db,
  dryRun,
  stats,
  enqueueForChannel,
  error,
}: HandleFailureOptions): Promise<void> => {
  const message = error instanceof Error ? error.message : "check failed";
  const health = markHealthFailure(db, channelName, subscription.url, message);

  await maybeSendFailureAlert(
    health.consecutiveFailures,
    subscription,
    message,
    channelName,
    effectiveChannelUrl,
    dryRun,
    enqueueForChannel,
    db,
  );

  stats.errors.push(`${subscription.url}: ${message}`);
};
