import { z } from "zod";
import type { SubscriptionConfig } from "../config/schema.ts";
import type { WachiDb } from "../db/connect.ts";
import { markHealthFailure } from "../db/mark-health-failure.ts";
import { sendNotification } from "../notify/send.ts";
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
  subscriptionUrl: string,
  message: string,
  channelName: string,
  effectiveChannelUrl: string,
  dryRun: boolean,
  enqueueForChannel: QueueFn,
): Promise<void> => {
  if (!(failures === 3 || failures >= 10) || dryRun) {
    return;
  }

  const body =
    failures >= 10
      ? `wachi: subscription ${subscriptionUrl} has been failing for 10+ checks. Consider removing it with wachi unsub -n "${channelName}".`
      : `wachi: subscription ${subscriptionUrl} has failed 3 consecutive checks. Last error: ${message}`;

  try {
    await enqueueForChannel(effectiveChannelUrl, async () => {
      await sendNotification({ appriseUrl: effectiveChannelUrl, body });
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
    subscription.url,
    message,
    channelName,
    effectiveChannelUrl,
    dryRun,
    enqueueForChannel,
  );

  stats.errors.push(`${subscription.url}: ${message}`);
};
