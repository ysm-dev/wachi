import { submitArchive } from "../archive/submit.ts";
import { printStderr, printStdout } from "../cli/io.ts";
import type { WachiDb } from "../db/connect.ts";
import {
  claimNextDelivery,
  completeDeliverySuccess,
  markDeliveryDispatching,
  markDeliveryRetry,
} from "../db/delivery-outbox.ts";
import { type DeliverySource, parseDeliverySource } from "../notify/delivery-source.ts";
import { sendNotification } from "../notify/send.ts";
import type { CheckStats } from "./handle-items.ts";

/**
 * Failures become available again immediately so the next scheduled `wachi
 * check` retries them. Within a single run the drainer stops at the first
 * failure, so this never causes a tight retry loop.
 */
const RETRY_BACKOFF_MS = 0;

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
    } catch {
      // Source metadata is only used for reporting and archiving. A corrupted
      // metadata blob must not block this payload or every later payload for the
      // destination.
      source = {
        channelName: "unknown",
        subscriptionUrl: delivery.link,
        title: delivery.link,
        archiveLink: null,
      };
    }

    try {
      await sendNotification({
        appriseUrl: effectiveChannelUrl,
        body: delivery.payload,
        sourceIdentity: source.sourceIdentity,
        onDispatchStart: () => {
          if (!markDeliveryDispatching(db, delivery)) {
            throw new Error("Delivery reservation was lost before dispatch");
          }
        },
      });

      if (!completeDeliverySuccess(db, delivery)) {
        throw new Error("Delivered notification could not be finalized");
      }

      stats.sent.push({
        title: source.title,
        link: delivery.link,
        channel_name: source.channelName,
      });
      if (source.archiveLink) {
        submitArchive(source.archiveLink, { isVerbose });
      }
      if (!isJson) {
        printStdout(`sent: ${source.title} -> ${source.channelName}`);
      }
    } catch (error) {
      const reason = errorReason(error);
      markDeliveryRetry(db, delivery, reason, RETRY_BACKOFF_MS);
      stats.errors.push(`${source.subscriptionUrl}: ${reason}`);
      if (isVerbose) {
        printStderr(`[verbose] delivery queued for retry: ${source.title} (${reason})`);
      }
      return;
    }
  }
};
