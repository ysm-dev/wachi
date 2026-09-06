import { createHash } from "node:crypto";
import { z } from "zod";
import type { SubscriptionConfig } from "../config/schema.ts";
import type { WachiDb, WachiDbSession } from "../db/connect.ts";
import { admitDeliveryWithOutboxInTransaction } from "../db/delivery-ledger.ts";
import { markHealthFailure } from "../db/mark-health-failure.ts";
import { serializeDeliverySource } from "../notify/delivery-source.ts";
import type { CheckStats } from "./handle-items.ts";

const handleFailureOptionsSchema = z.object({
  channelName: z.string(),
  destinationId: z.number().int().positive(),
  subscription: z.custom<SubscriptionConfig>(),
  db: z.custom<WachiDb>(),
  dryRun: z.boolean(),
  stats: z.custom<CheckStats>(),
  error: z.unknown(),
  attemptGeneration: z.number().int().nonnegative(),
});

type HandleFailureOptions = z.infer<typeof handleFailureOptionsSchema>;

export const toFailureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "check failed";

const maybeQueueFailureAlert = (
  failures: number,
  attemptGeneration: number,
  subscription: SubscriptionConfig,
  message: string,
  channelName: string,
  destinationId: number,
  db: WachiDbSession,
): void => {
  const isMilestone = failures > 100 && failures % 100 === 0;
  if (!(failures === 10 || failures === 100 || isMilestone)) {
    return;
  }

  const body =
    failures === 10
      ? `wachi: subscription ${subscription.url} has failed 10 consecutive checks. Last error: ${message}`
      : `wachi: subscription ${subscription.url} has been failing for ${failures} consecutive checks. Consider removing it with wachi unsub -n "${channelName}".`;

  const linkKey = createHash("sha256")
    .update("wachi:failure-alert:v1\0")
    .update(subscription.url)
    .update("\0")
    .update(String(failures))
    .update("\0")
    .update(String(attemptGeneration))
    .digest();

  admitDeliveryWithOutboxInTransaction(db, {
    destinationId,
    linkKey,
    payload: body,
    source: serializeDeliverySource({
      kind: "subscription-failure",
      channelName,
      subscriptionUrl: subscription.url,
      title: `Subscription failure (${failures})`,
      archiveLink: null,
      failureCount: failures,
    }),
    link: subscription.url,
  });
};

export const handleSubscriptionFailure = async ({
  channelName,
  destinationId,
  subscription,
  db,
  dryRun,
  stats,
  error,
  attemptGeneration,
}: HandleFailureOptions): Promise<void> => {
  const message = toFailureMessage(error);
  if (dryRun) {
    stats.errors.push(`${subscription.url}: ${message}`);
    return;
  }

  db.transaction(
    (tx) => {
      const health = markHealthFailure(
        tx,
        channelName,
        subscription.url,
        message,
        attemptGeneration,
      );
      if (health.attemptGeneration !== attemptGeneration) {
        return;
      }

      maybeQueueFailureAlert(
        health.consecutiveFailures,
        health.attemptGeneration,
        subscription,
        message,
        channelName,
        destinationId,
        tx,
      );
    },
    { behavior: "immediate" },
  );

  stats.errors.push(`${subscription.url}: ${message}`);
};
