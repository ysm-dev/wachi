import { submitArchive } from "../archive/submit.ts";
import { printStderr, printStdout } from "../cli/io.ts";
import type { WachiDb } from "../db/connect.ts";
import {
  claimNextDelivery,
  completeDeliverySuccess,
  markDeliveryDispatching,
  markDeliveryRetry,
  markDeliveryUncertain,
} from "../db/delivery-outbox.ts";
import { type DeliverySource, parseDeliverySource } from "../notify/delivery-source.ts";
import {
  type DeliveryFailureOutcome,
  NotificationDeliveryError,
  sendNotification,
} from "../notify/send.ts";
import type { CheckStats } from "./handle-items.ts";

/**
 * Determinate failures become available again immediately so the next scheduled
 * `wachi check` retries them (matching the previous "retry on next check"
 * behavior). Within a single run the drainer stops at the first failure, so this
 * never causes a tight retry loop.
 */
const RETRY_BACKOFF_MS = 0;

/**
 * After this many delivery attempts a repeatedly-failing item is parked as
 * `uncertain` instead of retried forever (e.g. a permanently broken runtime).
 */
const MAX_DELIVERY_ATTEMPTS = 5;

type DrainDestinationOutboxOptions = {
  db: WachiDb;
  destinationId: number;
  effectiveChannelUrl: string;
  isJson: boolean;
  isVerbose: boolean;
  stats: CheckStats;
};

const errorReason = (error: unknown): string => {
  return error instanceof Error ? error.message : "notification delivery failed";
};

/**
 * Classify a send failure. Determinate failures (the provider rejected the
 * message, or we never dispatched) are safe to retry; ambiguous outcomes are
 * not, because the provider may already have accepted the message.
 */
const classifyFailure = (error: unknown, dispatchStarted: boolean): DeliveryFailureOutcome => {
  if (error instanceof NotificationDeliveryError) {
    return error.outcome;
  }
  // An unrecognized error after dispatch began is ambiguous; before dispatch it
  // definitively did not reach the provider.
  return dispatchStarted ? "unknown" : "undelivered";
};

export const drainDestinationOutbox = async ({
  db,
  destinationId,
  effectiveChannelUrl,
  isJson,
  isVerbose,
  stats,
}: DrainDestinationOutboxOptions): Promise<void> => {
  while (true) {
    const delivery = claimNextDelivery(db, destinationId);
    if (!delivery) {
      return;
    }

    let source: DeliverySource;
    try {
      source = parseDeliverySource(delivery.source);
    } catch (error) {
      const reason = errorReason(error);
      markDeliveryUncertain(db, destinationId, delivery.linkKey, reason);
      stats.errors.push(`${delivery.link}: ${reason}`);
      return;
    }

    let dispatchStarted = false;
    try {
      await sendNotification({
        appriseUrl: effectiveChannelUrl,
        body: delivery.payload,
        sourceIdentity: source.sourceIdentity,
        onDispatchStart: () => {
          if (!markDeliveryDispatching(db, destinationId, delivery.linkKey)) {
            throw new Error("Delivery reservation was lost before dispatch");
          }
          dispatchStarted = true;
        },
      });

      if (!completeDeliverySuccess(db, destinationId, delivery.linkKey)) {
        throw new Error("Delivered notification could not be finalized");
      }

      stats.sent.push({
        title: source.title,
        link: delivery.link,
        channel_name: source.channelName,
      });
      submitArchive(source.archiveLink, { isVerbose });
      if (!isJson) {
        printStdout(`sent: ${source.title} -> ${source.channelName}`);
      }
    } catch (error) {
      const reason = errorReason(error);
      const failure = classifyFailure(error, dispatchStarted);
      const exhausted = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
      let outcomeLabel: string;
      if (failure === "undelivered" && !exhausted) {
        markDeliveryRetry(db, destinationId, delivery.linkKey, reason, RETRY_BACKOFF_MS);
        outcomeLabel = "queued for retry";
      } else {
        const detail = exhausted
          ? `exhausted after ${delivery.attempts} attempts: ${reason}`
          : reason;
        markDeliveryUncertain(db, destinationId, delivery.linkKey, detail);
        outcomeLabel = exhausted ? "parked (retries exhausted)" : "parked (uncertain)";
      }
      stats.errors.push(`${source.subscriptionUrl}: ${reason}`);
      if (isVerbose) {
        printStderr(`[verbose] delivery ${outcomeLabel}: ${source.title} (${reason})`);
      }
      return;
    }
  }
};
