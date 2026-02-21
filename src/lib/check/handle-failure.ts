import { z } from "zod";
import { toChannelNameKey } from "../config/channel-name-key.ts";
import {
  isCssSubscription,
  type ResolvedConfig,
  type SubscriptionConfig,
  type UserConfig,
} from "../config/schema.ts";
import type { CssSelectors } from "../css/extract.ts";
import { identifyCssSelectors } from "../css/identify.ts";
import type { WachiDb } from "../db/connect.ts";
import { markHealthFailure } from "../db/mark-health-failure.ts";
import { markHealthSuccess } from "../db/mark-health-success.ts";
import { sendNotification } from "../notify/send.ts";
import type { CheckStats } from "./handle-items.ts";

type QueueFn = (channelUrl: string, task: () => Promise<void>) => Promise<void>;

const handleFailureOptionsSchema = z.object({
  channelName: z.string(),
  effectiveChannelUrl: z.string(),
  subscription: z.custom<SubscriptionConfig>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  config: z.custom<ResolvedConfig>(),
  rawConfig: z.custom<UserConfig>(),
  onConfigMutated: z.custom<() => void>(),
  stats: z.custom<CheckStats>(),
  enqueueForChannel: z.custom<QueueFn>(),
  error: z.unknown(),
});

type HandleFailureOptions = z.infer<typeof handleFailureOptionsSchema>;

const updateRecoveredCssSelectors = (
  rawConfig: UserConfig,
  channelName: string,
  subscriptionUrl: string,
  selectors: CssSelectors,
): boolean => {
  const channel = rawConfig.channels?.find(
    (entry) => toChannelNameKey(entry.name) === toChannelNameKey(channelName),
  );
  const subscription = channel?.subscriptions.find((entry) => entry.url === subscriptionUrl);
  if (!subscription || !isCssSubscription(subscription)) {
    return false;
  }

  subscription.item_selector = selectors.item_selector;
  subscription.title_selector = selectors.title_selector;
  subscription.link_selector = selectors.link_selector;
  return true;
};

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
  config,
  rawConfig,
  onConfigMutated,
  stats,
  enqueueForChannel,
  error,
}: HandleFailureOptions): Promise<void> => {
  const message = error instanceof Error ? error.message : "check failed";
  const health = markHealthFailure(db, channelName, subscription.url, message);

  if (isCssSubscription(subscription) && health.consecutiveFailures >= 3 && !dryRun) {
    try {
      const identified = await identifyCssSelectors(subscription.url, config);
      const updated = updateRecoveredCssSelectors(
        rawConfig,
        channelName,
        subscription.url,
        identified.selectors,
      );
      if (updated) {
        onConfigMutated();
        markHealthSuccess(db, channelName, subscription.url);
      }
    } catch (recoveryError) {
      stats.errors.push(
        recoveryError instanceof Error ? recoveryError.message : "selector recovery failed",
      );
    }
  }

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
